import { describe, expect, it } from "vitest";
import {
  containerNameForSlot,
  LAUNCH_COOLDOWN_MS,
  planLaunches,
  planWarmLaunches,
  poolNameFromRequest,
  repoKeyFromUrl,
  repoUrlsForLaunch,
  requestMatchesPool,
} from "../src/matching";
import type { PendingRequest, PoolConfig, SlotState } from "../src/types";

const NOW = 1_700_000_000_000;

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: "bc-1",
    repoOwner: "acme",
    repoName: "payments",
    repoUrl: "https://github.com/acme/payments",
    labels: [{ key: "pool", value: "default" }],
    createdAtMs: NOW - 60_000,
    ...overrides,
  };
}

function pool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return { name: "default", repos: [], ...overrides };
}

describe("repoKeyFromUrl", () => {
  it("canonicalizes https, ssh and scp-like URLs to the same key", () => {
    expect(repoKeyFromUrl("https://github.com/Acme/Payments.git")).toBe(
      "acme/payments"
    );
    expect(repoKeyFromUrl("git@github.com:acme/payments.git")).toBe(
      "acme/payments"
    );
    expect(repoKeyFromUrl("ssh://git@github.com/acme/payments")).toBe(
      "acme/payments"
    );
    expect(repoKeyFromUrl("github.com/acme/payments")).toBe("acme/payments");
  });

  it("keeps nested GitLab group paths in the owner", () => {
    expect(repoKeyFromUrl("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "group/subgroup/repo"
    );
  });

  it("ignores credentials, ports and query strings", () => {
    expect(
      repoKeyFromUrl("https://user:secret@github.com:443/acme/payments?x=1")
    ).toBe("acme/payments");
  });

  it("returns undefined for URLs without an owner/name path", () => {
    expect(repoKeyFromUrl("https://github.com/")).toBeUndefined();
    expect(repoKeyFromUrl("")).toBeUndefined();
    expect(repoKeyFromUrl("::::")).toBeUndefined();
  });
});

describe("poolNameFromRequest", () => {
  it("reads the pool label", () => {
    expect(
      poolNameFromRequest(request({ labels: [{ key: "pool", value: "gpu" }] }))
    ).toBe("gpu");
  });

  it("defaults to 'default' when the pool label is absent or blank", () => {
    expect(poolNameFromRequest(request({ labels: [] }))).toBe("default");
    expect(
      poolNameFromRequest(request({ labels: [{ key: "pool", value: "  " }] }))
    ).toBe("default");
  });
});

describe("requestMatchesPool", () => {
  it("matches on pool name for repo-unrestricted pools", () => {
    expect(requestMatchesPool(request(), pool())).toBe(true);
    expect(requestMatchesPool(request(), pool({ name: "gpu" }))).toBe(false);
  });

  it("restricts repo-pinned pools to their broadcast repos", () => {
    const pinned = pool({ repos: ["git@github.com:Acme/Payments.git"] });
    expect(requestMatchesPool(request(), pinned)).toBe(true);
    expect(
      requestMatchesPool(
        request({
          repoOwner: "acme",
          repoName: "other",
          repoUrl: "https://github.com/acme/other",
        }),
        pinned
      )
    ).toBe(false);
  });

  it("never matches repo-less requests (workers always register repo-scoped)", () => {
    const repoless = request({
      repoOwner: undefined,
      repoName: undefined,
      repoUrl: undefined,
    });
    expect(
      requestMatchesPool(
        repoless,
        pool({ repos: ["https://github.com/acme/payments"] })
      )
    ).toBe(false);
    expect(requestMatchesPool(repoless, pool())).toBe(false);
  });

  it("requires a clone URL for any-repo pools", () => {
    expect(
      requestMatchesPool(request({ repoUrl: undefined }), pool())
    ).toBe(false);
  });
});

describe("repoUrlsForLaunch", () => {
  it("broadcasts the pool's full repo list when configured", () => {
    const pinned = pool({
      repos: ["https://github.com/acme/a", "https://github.com/acme/b"],
    });
    expect(repoUrlsForLaunch(request(), pinned)).toEqual(pinned.repos);
  });

  it("falls back to the request's repo for any-repo pools", () => {
    expect(repoUrlsForLaunch(request(), pool())).toEqual([
      "https://github.com/acme/payments",
    ]);
    expect(
      repoUrlsForLaunch(request({ repoUrl: undefined }), pool())
    ).toEqual([]);
  });
});

describe("planLaunches", () => {
  const baseArgs = {
    pools: [pool()],
    slotsByPool: new Map<string, SlotState[]>(),
    requestLaunchTimes: new Map<string, number>(),
    defaultMaxWorkersPerPool: 2,
    nowMs: NOW,
  };

  it("launches one slot per matching pending request, oldest first", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [
        request({ id: "bc-new", createdAtMs: NOW - 1_000 }),
        request({ id: "bc-old", createdAtMs: NOW - 120_000 }),
      ],
    });
    expect(launches.map((launch) => launch.spec.requestId)).toEqual([
      "bc-old",
      "bc-new",
    ]);
    expect(launches.map((launch) => launch.containerName)).toEqual([
      containerNameForSlot("default", 0),
      containerNameForSlot("default", 1),
    ]);
    expect(launches[0]?.spec.mode).toBe("serve");
    expect(launches[0]?.spec.poolName).toBe("default");
  });

  it("caps launches at the pool's max workers", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [
        request({ id: "bc-1" }),
        request({ id: "bc-2" }),
        request({ id: "bc-3" }),
      ],
    });
    expect(launches).toHaveLength(2);
  });

  it("honors a per-pool maxWorkers override", () => {
    const launches = planLaunches({
      ...baseArgs,
      pools: [pool({ maxWorkers: 1 })],
      pendingRequests: [request({ id: "bc-1" }), request({ id: "bc-2" })],
    });
    expect(launches).toHaveLength(1);
  });

  it("skips slots that are running or in launch cooldown", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [request({ id: "bc-1" }), request({ id: "bc-2" })],
      slotsByPool: new Map([
        [
          "default",
          [
            { slotIndex: 0, running: true },
            { slotIndex: 1, running: false, lastLaunchAtMs: NOW - 5_000 },
          ],
        ],
      ]),
    });
    expect(launches).toHaveLength(0);
  });

  it("reuses a slot once its cooldown has passed", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [request({ id: "bc-1" })],
      slotsByPool: new Map([
        [
          "default",
          [
            {
              slotIndex: 0,
              running: false,
              lastLaunchAtMs: NOW - LAUNCH_COOLDOWN_MS - 1,
            },
          ],
        ],
      ]),
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.slotIndex).toBe(0);
  });

  it("does not relaunch for a request that was recently launched", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [request({ id: "bc-1" })],
      requestLaunchTimes: new Map([["bc-1", NOW - 10_000]]),
    });
    expect(launches).toHaveLength(0);
  });

  it("retries a request whose launch cooldown expired but is still pending", () => {
    const launches = planLaunches({
      ...baseArgs,
      pendingRequests: [request({ id: "bc-1" })],
      requestLaunchTimes: new Map([["bc-1", NOW - LAUNCH_COOLDOWN_MS - 1]]),
    });
    expect(launches).toHaveLength(1);
  });

  it("routes requests to the pool named by their pool label", () => {
    const launches = planLaunches({
      ...baseArgs,
      pools: [pool(), pool({ name: "gpu" })],
      pendingRequests: [
        request({ id: "bc-gpu", labels: [{ key: "pool", value: "gpu" }] }),
      ],
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.spec.poolName).toBe("gpu");
    expect(launches[0]?.containerName).toBe(containerNameForSlot("gpu", 0));
  });
});

describe("planWarmLaunches", () => {
  const pinned = pool({
    name: "cloudflare-test",
    repos: ["https://github.com/acme/payments"],
  });

  it("keeps a warm floor of 1 when no slots are running", () => {
    const launches = planWarmLaunches({
      pools: [pinned],
      slotsByPool: new Map(),
      reservedContainerNames: new Set(),
      defaultMinWorkersPerPool: 1,
      defaultMaxWorkersPerPool: 3,
      nowMs: NOW,
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.spec.mode).toBe("warm");
    expect(launches[0]?.spec.repoUrls).toEqual(pinned.repos);
    expect(launches[0]?.containerName).toBe(
      containerNameForSlot("cloudflare-test", 0)
    );
  });

  it("does nothing when the warm floor is already met", () => {
    const launches = planWarmLaunches({
      pools: [pinned],
      slotsByPool: new Map([
        ["cloudflare-test", [{ slotIndex: 0, running: true }]],
      ]),
      reservedContainerNames: new Set(),
      defaultMinWorkersPerPool: 1,
      defaultMaxWorkersPerPool: 3,
      nowMs: NOW,
    });
    expect(launches).toHaveLength(0);
  });

  it("skips slots reserved for serve launches this tick", () => {
    const launches = planWarmLaunches({
      pools: [pinned],
      slotsByPool: new Map(),
      reservedContainerNames: new Set([
        containerNameForSlot("cloudflare-test", 0),
      ]),
      defaultMinWorkersPerPool: 1,
      defaultMaxWorkersPerPool: 3,
      nowMs: NOW,
    });
    // Slot 0 is reserved (counts toward the floor), so no warm launch needed.
    expect(launches).toHaveLength(0);
  });

  it("skips pools with no repos", () => {
    const launches = planWarmLaunches({
      pools: [pool({ repos: [] })],
      slotsByPool: new Map(),
      reservedContainerNames: new Set(),
      defaultMinWorkersPerPool: 1,
      defaultMaxWorkersPerPool: 3,
      nowMs: NOW,
    });
    expect(launches).toHaveLength(0);
  });

  it("honors minWorkers=0 to allow scale-to-zero", () => {
    const launches = planWarmLaunches({
      pools: [pool({ ...pinned, minWorkers: 0 })],
      slotsByPool: new Map(),
      reservedContainerNames: new Set(),
      defaultMinWorkersPerPool: 1,
      defaultMaxWorkersPerPool: 3,
      nowMs: NOW,
    });
    expect(launches).toHaveLength(0);
  });
});
