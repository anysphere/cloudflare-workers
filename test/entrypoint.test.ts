import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = fileURLToPath(new URL("../container/entrypoint.sh", import.meta.url));

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-entrypoint-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeScript(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function snapshotKey(url: string): string {
  return execFileSync("sha256sum", { input: url, encoding: "utf8" }).split(/\s+/)[0] ?? "";
}

function runEntrypoint(options: {
  repoUrl?: string | undefined;
  snapshotBaseUrl?: string;
}): {
  cloneUrl: string | undefined;
  gitLog: string;
  curlLog: string;
  agentLog: string;
  workerDir: string;
  stderr: string;
} {
  const root = scratch();
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workspaces = join(root, "workspaces");
  mkdirSync(bin);
  mkdirSync(home);

  const gitLog = join(root, "git.log");
  const cloneUrlFile = join(root, "clone-url");
  const curlLog = join(root, "curl.log");
  const agentLog = join(root, "agent.log");

  writeScript(
    join(bin, "git"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
if [[ "\${1:-}" == "clone" ]]; then
  mkdir -p "\${!#}/.git"
  printf '%s\\n' "\${3}" > "$CLONE_URL_FILE"
fi
`
  );
  writeScript(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CURL_LOG"
`
  );
  writeScript(
    join(bin, "agent"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$AGENT_LOG"
`
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    CURSOR_API_KEY: "test-key",
    CURSOR_POOL: "default",
    WORKSPACES_DIR: workspaces,
    CURSOR_DATA_DIR: join(root, "cursor-data"),
    GIT_LOG: gitLog,
    CLONE_URL_FILE: cloneUrlFile,
    CURL_LOG: curlLog,
    AGENT_LOG: agentLog,
  };
  delete env.GIT_TOKEN;
  delete env.GIT_USERNAME;
  if (options.repoUrl === undefined) {
    delete env.CURSOR_REPO_URL;
  } else {
    env.CURSOR_REPO_URL = options.repoUrl;
  }
  if (options.snapshotBaseUrl !== undefined) {
    env.SNAPSHOT_BASE_URL = options.snapshotBaseUrl;
    env.SNAPSHOT_AUTH_TOKEN = "snap";
  } else {
    delete env.SNAPSHOT_BASE_URL;
    delete env.SNAPSHOT_AUTH_TOKEN;
  }

  const result = spawnSync("bash", [entrypoint], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `entrypoint exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  return {
    cloneUrl: (() => {
      try {
        return readFileSync(cloneUrlFile, "utf8").trim();
      } catch {
        return undefined;
      }
    })(),
    gitLog: (() => {
      try {
        return readFileSync(gitLog, "utf8");
      } catch {
        return "";
      }
    })(),
    curlLog: (() => {
      try {
        return readFileSync(curlLog, "utf8");
      } catch {
        return "";
      }
    })(),
    agentLog: readFileSync(agentLog, "utf8").trim(),
    workerDir: join(workspaces, "repo-0"),
    stderr: result.stderr,
  };
}

describe("entrypoint CURSOR_REPO_URL", () => {
  it("prepends https:// to scheme-less identities before clone and snapshot key", () => {
    const identity = "github.com/octocat/Hello-World";
    const normalized = "https://github.com/octocat/Hello-World";
    const run = runEntrypoint({
      repoUrl: identity,
      snapshotBaseUrl: "http://snapshots.test",
    });

    expect(run.cloneUrl).toBe(normalized);
    expect(run.stderr).toContain(`cloning ${normalized}`);
    expect(run.stderr).toContain(`repo=${normalized}`);
    expect(run.curlLog).toContain(`http://snapshots.test/${snapshotKey(normalized)}.tar.gz`);
    expect(run.curlLog).not.toContain(snapshotKey(identity));
    expect(run.agentLog).toMatch(/worker --worker-dir .* --pool default start --verbose/);

    expect(runEntrypoint({ repoUrl: "origin.cursor.com/git/tmp-abc.git" }).cloneUrl).toBe(
      "https://origin.cursor.com/git/tmp-abc.git"
    );
  });

  it("leaves already-schemed and git@ URLs unchanged", () => {
    const https = "https://github.com/octocat/Hello-World";
    const ssh = "git@github.com:octocat/Hello-World.git";
    const http = "http://github.com/octocat/Hello-World";
    const sshScheme = "ssh://git@github.com/octocat/Hello-World.git";

    expect(runEntrypoint({ repoUrl: https }).cloneUrl).toBe(https);
    expect(runEntrypoint({ repoUrl: ssh }).cloneUrl).toBe(ssh);
    expect(runEntrypoint({ repoUrl: http }).cloneUrl).toBe(http);
    expect(runEntrypoint({ repoUrl: sshScheme }).cloneUrl).toBe(sshScheme);
  });

  it("takes the any-repo path when CURSOR_REPO_URL is empty or unset", () => {
    for (const repoUrl of [undefined, ""]) {
      const run = runEntrypoint({ repoUrl });
      expect(run.cloneUrl).toBeUndefined();
      expect(run.gitLog).toBe("");
      expect(run.stderr).toContain("starting any-repo pool worker");
      expect(run.stderr).not.toContain("cloning");
      expect(existsSync(run.workerDir)).toBe(true);
      expect(run.agentLog).toMatch(/worker --worker-dir .* --pool default start --verbose/);
    }
  });
});
