/**
 * Minimal client for the Cursor fleet-management API (https://api.cursor.com),
 * authenticated with a team service-account API key. Only the endpoints the
 * scheduler needs:
 *
 *   GET /v0/private-workers/pending-requests  – agent runs waiting for a worker
 *   GET /v0/private-workers                   – connected workers (status page)
 *   GET /v0/private-workers/pools             – durable pool registry (status page)
 */
import type { PendingRequest } from "./types";

const MAX_PENDING_PAGES = 5;
const PAGE_SIZE = 100;

export interface ConnectedWorker {
  readonly workerId: string;
  readonly isInUse: boolean;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly tags?: readonly { readonly key: string; readonly value: string }[];
}

export class CursorApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string
  ) {
    super(`Cursor API ${endpoint} failed with ${status}: ${body.slice(0, 300)}`);
  }
}

export class CursorApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new CursorApiError(response.status, path, await response.text());
    }
    return response.json();
  }

  /** All pending pool requests visible to the service account (paginated). */
  async listPendingRequests(): Promise<PendingRequest[]> {
    const requests: PendingRequest[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PENDING_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageToken !== undefined) {
        query.set("pageToken", pageToken);
      }
      const body = (await this.get(
        `/v0/private-workers/pending-requests?${query.toString()}`
      )) as {
        requests?: {
          id: string;
          repoOwner?: string;
          repoName?: string;
          repoUrl?: string;
          labels?: { key: string; value: string }[];
          createdAtMs: number;
        }[];
        nextPageToken?: string;
      };
      for (const request of body.requests ?? []) {
        requests.push({
          id: request.id,
          repoOwner: request.repoOwner,
          repoName: request.repoName,
          repoUrl: request.repoUrl,
          labels: request.labels ?? [],
          createdAtMs: request.createdAtMs,
        });
      }
      pageToken = body.nextPageToken;
      if (pageToken === undefined) {
        break;
      }
    }
    return requests;
  }

  /** Connected workers, for the /status endpoint. */
  async listWorkers(): Promise<ConnectedWorker[]> {
    const body = (await this.get(
      "/v0/private-workers?status=all&limit=100"
    )) as { workers?: ConnectedWorker[] };
    return body.workers ?? [];
  }

  /** Durable pool registry rows, for the /status endpoint. */
  async listPools(): Promise<unknown> {
    const body = (await this.get("/v0/private-workers/pools")) as {
      pools?: unknown;
    };
    return body.pools ?? [];
  }
}
