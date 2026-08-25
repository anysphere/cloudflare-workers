import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/config";
import {
  guestEnvForClaim,
  parsePendingRequest,
  parseSse,
  poolFromLabels,
  runController,
  type PendingRequest,
} from "../src/controller";

const API = "https://api.example.test";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function pending(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    userId: 42,
    labels: [{ key: "pool", value: "gpu" }],
    createdAtMs: 1,
    repoUrls: ["https://github.com/acme/payments"],
    someFutureField: true,
    ...extra,
  };
}

/** Fake fleet API: one list page, one SSE stream, and a claim that 409s on `taken`. */
function fakeFleet(options: {
  listed: Record<string, unknown>[];
  streamCursor?: string;
  stream: string[];
  streamStatus?: number;
}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const claims: Array<{ id: string; workerId: string }> = [];
  let streamOpens = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/pending-requests/stream")) {
      streamOpens += 1;
      if (options.streamStatus !== undefined && streamOpens === 1) {
        return new Response("gone", { status: options.streamStatus });
      }
      return new Response(sseBody(options.stream), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes("/pending-requests")) {
      return Response.json({ requests: options.listed, streamCursor: options.streamCursor });
    }
    if (url.endsWith("/claim")) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { id: string; workerId: string }) : undefined;
      if (body === undefined) return new Response("bad", { status: 400 });
      if (body.id === "taken") return new Response("conflict", { status: 409 });
      claims.push(body);
      return Response.json(body);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, claims, streamOpens: () => streamOpens };
}

describe("parsePositiveInt", () => {
  it("parses valid values and falls back otherwise", () => {
    expect(parsePositiveInt("7", 3)).toBe(7);
    expect(parsePositiveInt(undefined, 3)).toBe(3);
    expect(parsePositiveInt("-1", 3)).toBe(3);
    expect(parsePositiveInt("2.5", 3)).toBe(3);
  });
});

describe("parsePendingRequest", () => {
  it("keeps known fields, ignores unknown ones, requires id", () => {
    expect(parsePendingRequest(pending("bc-1", { repoUrl: "https://github.com/acme/payments" }))).toEqual({
      id: "bc-1",
      userId: 42,
      repoOwner: undefined,
      repoName: undefined,
      repoUrl: "https://github.com/acme/payments",
      labels: [{ key: "pool", value: "gpu" }],
    });
    expect(parsePendingRequest({ labels: [] })).toBeUndefined();
    expect(parsePendingRequest("nope")).toBeUndefined();
  });
});

describe("poolFromLabels / guestEnvForClaim", () => {
  it("defaults the pool and only sets repo vars for repo-bound claims", () => {
    expect(poolFromLabels([])).toBe("default");
    const anyRepo: PendingRequest = { id: "bc-1", labels: [] };
    expect(guestEnvForClaim(anyRepo, "cf-1", "key")).toEqual({
      CURSOR_API_KEY: "key",
      CURSOR_POOL: "default",
      CURSOR_AGENT_WORKER_ID: "cf-1",
      CURSOR_WORKER_NAME: "cf-1",
      CURSOR_REQUEST_ID: "bc-1",
      CURSOR_BC_ID: "bc-1",
    });
    const repoBound: PendingRequest = {
      id: "bc-2",
      userId: 7,
      repoOwner: "acme",
      repoName: "payments",
      repoUrl: "https://github.com/acme/payments",
      labels: [{ key: "pool", value: "gpu" }],
    };
    expect(guestEnvForClaim(repoBound, "cf-2", "key")).toMatchObject({
      CURSOR_POOL: "gpu",
      CURSOR_USER_ID: "7",
      CURSOR_REPO_URL: "https://github.com/acme/payments",
      CURSOR_REPO_OWNER: "acme",
      CURSOR_REPO_NAME: "payments",
    });
  });
});

describe("parseSse", () => {
  it("splits events across chunk boundaries and skips comments", async () => {
    const events = [];
    for await (const event of parseSse(
      sseBody([": connected\n\nevent: created\nid: 5\nda", "ta: {\"id\":\"x\"}\n\nevent: heartbeat\nid: 6\ndata: {}\n\n"])
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "created", id: "5", data: "{\"id\":\"x\"}" },
      { event: "heartbeat", id: "6", data: "{}" },
    ]);
  });
});

describe("runController", () => {
  it("claims listed requests, then claims created events from the stream", async () => {
    const fleet = fakeFleet({
      listed: [pending("listed-1"), pending("taken")],
      streamCursor: "c0",
      stream: [
        "event: heartbeat\nid: c1\ndata: {}\n\n",
        `event: created\nid: c2\ndata: ${JSON.stringify(pending("streamed-1"))}\n\n`,
        `event: created\nid: c3\ndata: ${JSON.stringify(pending("listed-1"))}\n\n`,
        "event: claimed\nid: c4\ndata: {\"id\":\"streamed-1\"}\n\n",
      ],
    });
    const spawned: string[] = [];
    let ticks = 0;
    const summary = await runController({
      apiUrl: API,
      apiKey: "key",
      pool: "gpu",
      budgetMs: 1000,
      fetchImpl: fleet.fetchImpl,
      spawn: async (request, workerId) => {
        expect(workerId).toMatch(/^cf-/);
        spawned.push(request.id);
      },
      // Budget holds for the list and one stream open, then expires.
      now: () => (ticks++ < 4 ? 0 : 2000),
      sleep: async () => undefined,
    });

    expect(summary).toEqual({ listed: 2, claimed: 2 });
    expect(spawned).toEqual(["listed-1", "streamed-1"]);
    expect(fleet.claims.map((claim) => claim.id)).toEqual(["listed-1", "streamed-1"]);
    expect(fleet.streamOpens()).toBe(1);
    const list = fleet.calls.find((call) => call.url.includes("/pending-requests?"));
    expect(list?.url).toBe(`${API}/v0/private-workers/pending-requests?pool=gpu&limit=100`);
    const stream = fleet.calls.find((call) => call.url.includes("/stream"));
    expect(stream?.url).toBe(`${API}/v0/private-workers/pending-requests/stream?pool=gpu&cursor=c0`);
  });

  it("pauses before reconnecting when the server closes or refuses the stream", async () => {
    const fleet = fakeFleet({ listed: [], streamCursor: "c0", stream: [], streamStatus: 429 });
    const sleeps: number[] = [];
    let clock = 0;
    await runController({
      apiUrl: API,
      apiKey: "key",
      pool: "gpu",
      budgetMs: 12_000,
      fetchImpl: fleet.fetchImpl,
      spawn: async () => undefined,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    // 429 -> pause 5s; empty 200 stream closed by server -> pause 5s; then only 2s of budget left.
    expect(sleeps).toEqual([5000, 5000, 2000]);
    expect(fleet.streamOpens()).toBe(3);
  });

  it("re-lists when the stream cursor has expired (410)", async () => {
    const fleet = fakeFleet({
      listed: [],
      streamCursor: "c0",
      stream: [],
      streamStatus: 410,
    });
    let ticks = 0;
    await runController({
      apiUrl: API,
      apiKey: "key",
      pool: "gpu",
      budgetMs: 1000,
      fetchImpl: fleet.fetchImpl,
      spawn: async () => undefined,
      now: () => (ticks++ < 6 ? 0 : 2000),
      sleep: async () => undefined,
    });
    const lists = fleet.calls.filter((call) => call.url.includes("/pending-requests?"));
    expect(lists.length).toBe(2);
    expect(fleet.streamOpens()).toBe(2);
  });

  it("fails loudly on 401 so the cron log shows a bad key", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("Agent-scoped service-account API key required", { status: 401 });
    await expect(
      runController({
        apiUrl: API,
        apiKey: "bad",
        pool: "gpu",
        budgetMs: 1000,
        fetchImpl,
        spawn: async () => undefined,
      })
    ).rejects.toThrow(/HTTP 401/);
  });
});
