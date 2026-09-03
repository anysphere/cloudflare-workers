/**
 * In-Worker pool controller.
 *
 * One run: list pending private-worker requests for the pool, claim each, then
 * hold the SSE stream open and claim `created` events until the time budget is
 * spent. Whenever the server closes the stream (the list cursor's five-minute
 * lifetime ended, or it was invalidated) the run re-lists rather than resuming,
 * which both renews the cursor and catches anything missed. The cron trigger
 * starts the next run.
 *
 * POST /claim is the only mutex. It is atomic on the server: 409 means another
 * controller got there first, 404 means the request is gone. Overlapping runs
 * are therefore harmless, and no local state survives a run.
 *
 * No Cloudflare imports here so it is unit-testable under node/vitest.
 */

const PENDING_REQUESTS_PATH = "/v0/private-workers/pending-requests";
const PENDING_REQUESTS_STREAM_PATH = `${PENDING_REQUESTS_PATH}/stream`;
const CLAIM_PATH = "/v0/private-workers/claim";
const POOLS_PATH = "/v0/private-workers/pools";

export interface PendingRequest {
  id: string;
  userId?: number;
  repoOwner?: string;
  repoName?: string;
  repoUrl?: string;
  labels: Array<{ key: string; value: string }>;
}

export interface ControllerOptions {
  apiUrl: string;
  apiKey: string;
  pool: string;
  /** Wall-clock budget for this run; the stream is closed when it elapses. */
  budgetMs: number;
  /** Start a guest for a claimed request. Throwing marks the claim failed. */
  spawn: (request: PendingRequest, workerId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
  /** Pause between reconnects (test hook). */
  sleep?: (ms: number) => Promise<void>;
}

/** Wait before reopening a stream the server closed or refused (429/5xx). */
const RECONNECT_DELAY_MS = 5_000;

export interface ControllerSummary {
  listed: number;
  claimed: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Lenient parse: unknown keys are ignored so new API fields never break us. */
export function parsePendingRequest(raw: unknown): PendingRequest | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = optionalString(record.id);
  if (id === undefined) {
    return undefined;
  }
  const labels: Array<{ key: string; value: string }> = [];
  if (Array.isArray(record.labels)) {
    for (const label of record.labels) {
      if (typeof label !== "object" || label === null) {
        continue;
      }
      const { key, value } = label as Record<string, unknown>;
      if (typeof key === "string" && typeof value === "string") {
        labels.push({ key, value });
      }
    }
  }
  return {
    id,
    userId: typeof record.userId === "number" ? record.userId : undefined,
    repoOwner: optionalString(record.repoOwner),
    repoName: optionalString(record.repoName),
    repoUrl: optionalString(record.repoUrl),
    labels,
  };
}

/** Same rule as the official CLI controller: `pool` label, else `default`. */
export function poolFromLabels(
  labels: Array<{ key: string; value: string }>
): string {
  const pool = labels.find((label) => label.key === "pool")?.value.trim();
  return pool !== undefined && pool.length > 0 ? pool : "default";
}

/** Env the guest `agent worker start` process reads. Mirrors the CLI spawn hook. */
export function guestEnvForClaim(
  request: PendingRequest,
  workerId: string,
  apiKey: string
): Record<string, string> {
  const env: Record<string, string> = {
    CURSOR_API_KEY: apiKey,
    CURSOR_POOL: poolFromLabels(request.labels),
    CURSOR_AGENT_WORKER_ID: workerId,
    CURSOR_WORKER_NAME: workerId,
    CURSOR_REQUEST_ID: request.id,
    CURSOR_BC_ID: request.id,
  };
  if (request.userId !== undefined) {
    env.CURSOR_USER_ID = String(request.userId);
  }
  if (request.repoUrl !== undefined) {
    env.CURSOR_REPO_URL = request.repoUrl;
  }
  if (request.repoOwner !== undefined) {
    env.CURSOR_REPO_OWNER = request.repoOwner;
  }
  if (request.repoName !== undefined) {
    env.CURSOR_REPO_NAME = request.repoName;
  }
  return env;
}

export interface SseEvent {
  event?: string;
  id?: string;
  data?: string;
}

function parseSseBlock(block: string): SseEvent | undefined {
  const event: SseEvent = {};
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event.event = value;
    } else if (field === "id") {
      event.id = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length > 0) {
    event.data = dataLines.join("\n");
  }
  return event.event === undefined && event.id === undefined && event.data === undefined
    ? undefined
    : event;
}

/** Minimal text/event-stream reader: yields one event per blank-line-terminated block. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseBlock(block);
        if (event !== undefined) {
          yield event;
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function apiHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept: "application/json", ...extra };
}

async function failure(label: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  return new Error(`${label} -> HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

export async function runController(options: ControllerOptions): Promise<ControllerSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.budgetMs;
  const pause = async (): Promise<void> => {
    const ms = Math.min(RECONNECT_DELAY_MS, deadline - now());
    if (ms > 0) {
      await sleep(ms);
    }
  };
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const pool = encodeURIComponent(options.pool);
  const summary: ControllerSummary = { listed: 0, claimed: 0 };
  const handled = new Set<string>();

  const registerPool = async (): Promise<void> => {
    const response = await fetchImpl(`${apiUrl}${POOLS_PATH}`, {
      method: "POST",
      headers: apiHeaders(options.apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({ scope: "team", poolName: options.pool }),
    });
    if (!response.ok) {
      throw await failure(`POST ${POOLS_PATH}`, response);
    }
    log(`pool ${options.pool} registered`);
  };

  const claimAndSpawn = async (request: PendingRequest): Promise<void> => {
    if (handled.has(request.id)) {
      return;
    }
    handled.add(request.id);
    const workerId = `cf-${crypto.randomUUID()}`;
    const response = await fetchImpl(`${apiUrl}${CLAIM_PATH}`, {
      method: "POST",
      headers: apiHeaders(options.apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({ id: request.id, workerId }),
    });
    if (response.status === 409 || response.status === 404) {
      log(`request ${request.id} already ${response.status === 409 ? "claimed" : "gone"}`);
      return;
    }
    if (response.status === 401) {
      throw await failure(`POST ${CLAIM_PATH}`, response);
    }
    if (!response.ok) {
      log(String(await failure(`POST ${CLAIM_PATH} for ${request.id}`, response)));
      return;
    }
    summary.claimed += 1;
    log(`claimed ${request.id} as ${workerId}; spawning`);
    await options.spawn(request, workerId);
  };

  const listPending = async (): Promise<string | undefined> => {
    const response = await fetchImpl(
      `${apiUrl}${PENDING_REQUESTS_PATH}?pool=${pool}&limit=100`,
      { headers: apiHeaders(options.apiKey) }
    );
    if (!response.ok) {
      throw await failure(`GET ${PENDING_REQUESTS_PATH}`, response);
    }
    const body = (await response.json()) as { requests?: unknown[]; streamCursor?: unknown };
    for (const raw of body.requests ?? []) {
      const request = parsePendingRequest(raw);
      if (request !== undefined) {
        summary.listed += 1;
        await claimAndSpawn(request);
      }
    }
    return optionalString(body.streamCursor);
  };

  // Returns the cursor to retry with, or undefined to re-list.
  const watch = async (cursor: string): Promise<string | undefined> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return cursor;
    }
    const signal = AbortSignal.timeout(remaining);
    let response: Response;
    try {
      response = await fetchImpl(
        `${apiUrl}${PENDING_REQUESTS_STREAM_PATH}?pool=${pool}&cursor=${encodeURIComponent(cursor)}`,
        { headers: apiHeaders(options.apiKey, { accept: "text/event-stream" }), signal }
      );
    } catch (error) {
      if (signal.aborted) {
        return cursor;
      }
      throw error;
    }
    if (response.status === 410) {
      log("stream cursor expired; re-listing");
      return undefined;
    }
    if (response.status === 401 || response.status === 400) {
      throw await failure(`GET ${PENDING_REQUESTS_STREAM_PATH}`, response);
    }
    if (!response.ok || response.body === null) {
      if (!response.ok) {
        log(String(await failure(`GET ${PENDING_REQUESTS_STREAM_PATH}`, response)));
      }
      await pause();
      return cursor;
    }
    log(`stream open (${Math.round(remaining / 1000)}s left)`);
    try {
      for await (const event of parseSse(response.body)) {
        if (event.event !== "created" || event.data === undefined) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }
        const request = parsePendingRequest(parsed);
        if (request !== undefined) {
          await claimAndSpawn(request);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
    if (signal.aborted) {
      log("stream closed: budget spent");
      return cursor;
    }
    log("stream closed by server; re-listing");
    await pause();
    return undefined;
  };

  await registerPool();

  let cursor: string | undefined;
  while (now() < deadline) {
    if (cursor === undefined) {
      cursor = await listPending();
      if (cursor === undefined) {
        log("list response had no streamCursor; next run will list again");
        break;
      }
    }
    cursor = await watch(cursor);
  }
  return summary;
}
