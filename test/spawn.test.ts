import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/config";
import {
  containerNameForSpawn,
  guestEnvFromSpawn,
  isRetryableSpawnStatus,
  parseSpawnBody,
  requireGuestSpawnEnv,
  SpawnRequestError,
} from "../src/spawn";

describe("parsePositiveInt", () => {
  it("parses valid values and falls back otherwise", () => {
    expect(parsePositiveInt("7", 3)).toBe(7);
    expect(parsePositiveInt(undefined, 3)).toBe(3);
    expect(parsePositiveInt("", 3)).toBe(3);
    expect(parsePositiveInt("-1", 3)).toBe(3);
    expect(parsePositiveInt("2.5", 3)).toBe(3);
  });
});

describe("parseSpawnBody", () => {
  it("accepts a flat object", () => {
    expect(parseSpawnBody({ CURSOR_POOL: "gpu" })).toEqual({
      CURSOR_POOL: "gpu",
    });
  });

  it("rejects arrays and non-objects", () => {
    expect(() => parseSpawnBody([])).toThrow(SpawnRequestError);
    expect(() => parseSpawnBody("nope")).toThrow(SpawnRequestError);
    expect(() => parseSpawnBody(null)).toThrow(SpawnRequestError);
  });
});

describe("guestEnvFromSpawn", () => {
  it("forwards CURSOR_* that worker start needs and strips fleet API URLs", () => {
    expect(
      guestEnvFromSpawn({
        CURSOR_API_KEY: "key",
        CURSOR_POOL: "gpu",
        CURSOR_WORKER_NAME: "w-1",
        CURSOR_AGENT_WORKER_ID: "w-1",
        CURSOR_REQUEST_ID: "bc-1",
        CURSOR_BC_ID: "bc-1",
        CURSOR_REPO_URL: "https://github.com/acme/payments",
        CURSOR_REPO_OWNER: "acme",
        CURSOR_REPO_NAME: "payments",
        CURSOR_USER_ID: "42",
        CURSOR_API_URL: "https://api.cursor.com",
        CURSOR_API_ENDPOINT: "https://api.cursor.com",
        IGNORE_ME: "nope",
      })
    ).toEqual({
      CURSOR_API_KEY: "key",
      CURSOR_POOL: "gpu",
      CURSOR_WORKER_NAME: "w-1",
      CURSOR_AGENT_WORKER_ID: "w-1",
      CURSOR_REQUEST_ID: "bc-1",
      CURSOR_BC_ID: "bc-1",
      CURSOR_REPO_URL: "https://github.com/acme/payments",
      CURSOR_REPO_OWNER: "acme",
      CURSOR_REPO_NAME: "payments",
      CURSOR_USER_ID: "42",
    });
  });

  it("drops empty values", () => {
    expect(guestEnvFromSpawn({ CURSOR_POOL: "", CURSOR_API_KEY: "k" })).toEqual({
      CURSOR_API_KEY: "k",
    });
  });
});

describe("containerNameForSpawn", () => {
  it("prefers CURSOR_AGENT_WORKER_ID", () => {
    expect(
      containerNameForSpawn({
        CURSOR_AGENT_WORKER_ID: "wid",
        CURSOR_REQUEST_ID: "bc-1",
      })
    ).toBe("spawn/wid");
  });

  it("falls back to request id", () => {
    expect(containerNameForSpawn({ CURSOR_REQUEST_ID: "bc-1" })).toBe(
      "spawn/bc-1"
    );
  });

  it("rejects a missing id", () => {
    expect(() => containerNameForSpawn({ CURSOR_POOL: "gpu" })).toThrow(
      /CURSOR_AGENT_WORKER_ID/
    );
  });
});

describe("requireGuestSpawnEnv", () => {
  const valid = {
    CURSOR_API_KEY: "key",
    CURSOR_POOL: "gpu",
    CURSOR_REPO_URL: "https://github.com/acme/payments",
  };

  it("accepts a complete payload", () => {
    expect(() => requireGuestSpawnEnv(valid)).not.toThrow();
  });

  it("requires api key, pool, and repo url", () => {
    expect(() =>
      requireGuestSpawnEnv({
        CURSOR_POOL: valid.CURSOR_POOL,
        CURSOR_REPO_URL: valid.CURSOR_REPO_URL,
      })
    ).toThrow(/CURSOR_API_KEY/);
    expect(() =>
      requireGuestSpawnEnv({
        CURSOR_API_KEY: "k",
        CURSOR_REPO_URL: valid.CURSOR_REPO_URL,
      })
    ).toThrow(/CURSOR_POOL/);
    expect(() =>
      requireGuestSpawnEnv({ CURSOR_API_KEY: "k", CURSOR_POOL: "gpu" })
    ).toThrow(/CURSOR_REPO_URL/);
  });
});

describe("isRetryableSpawnStatus", () => {
  it("treats 5xx, 429, 409, 408 as retryable and 4xx as fatal", () => {
    expect(isRetryableSpawnStatus(500)).toBe(true);
    expect(isRetryableSpawnStatus(429)).toBe(true);
    expect(isRetryableSpawnStatus(409)).toBe(true);
    expect(isRetryableSpawnStatus(400)).toBe(false);
    expect(isRetryableSpawnStatus(401)).toBe(false);
    expect(isRetryableSpawnStatus(200)).toBe(false);
  });
});

describe("container/spawn.sh", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "container/spawn.sh");
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };

  it("exits 2 when required hook config is missing", () => {
    const missingUrl = spawnSync("bash", [script], {
      cwd: repoRoot,
      env: baseEnv,
      encoding: "utf8",
    });
    expect(missingUrl.status).toBe(2);
    expect(missingUrl.stderr).toMatch(/CLOUDFLARE_WORKER_URL/);

    const missingPool = spawnSync("bash", [script], {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        CLOUDFLARE_WORKER_URL: "https://example.workers.dev",
        CLOUDFLARE_SPAWN_TOKEN: "tok",
        CURSOR_API_KEY: "key",
        CURSOR_REPO_URL: "https://github.com/acme/payments",
      },
      encoding: "utf8",
    });
    expect(missingPool.status).toBe(2);
    expect(missingPool.stderr).toMatch(/CURSOR_POOL/);
  });

  it("maps HTTP 2xx to 0, 5xx to 1, and 4xx to 2", async () => {
    const { createServer } = await import("node:http");
    const cases: Array<{ status: number; exit: number }> = [
      { status: 200, exit: 0 },
      { status: 503, exit: 1 },
      { status: 401, exit: 2 },
    ];
    for (const testCase of cases) {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const server = createServer((_req, res) => {
          res.writeHead(testCase.status, { "content-type": "application/json" });
          res.end("{\"ok\":true}");
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          const child = spawn("bash", [script], {
            cwd: repoRoot,
            env: {
              ...baseEnv,
              CLOUDFLARE_WORKER_URL: `http://127.0.0.1:${address.port}`,
              CLOUDFLARE_SPAWN_TOKEN: "tok",
              CURSOR_API_KEY: "key",
              CURSOR_POOL: "gpu",
              CURSOR_REPO_URL: "https://github.com/acme/payments",
            },
          });
          child.on("error", (error) => {
            server.close();
            reject(error);
          });
          child.on("exit", (code) => {
            server.close(() => resolve(code ?? 1));
          });
        });
      });
      expect(exitCode).toBe(testCase.exit);
    }
  });
});
