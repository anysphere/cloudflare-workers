import { describe, expect, it } from "vitest";
import {
  parsePoolsConfig,
  parsePositiveInt,
  poolConfigFingerprint,
} from "../src/config";

describe("parsePoolsConfig", () => {
  it("parses pools with names, repos and maxWorkers", () => {
    const pools = parsePoolsConfig(
      JSON.stringify([
        { name: "default", repos: ["https://github.com/acme/a"] },
        { name: "gpu", maxWorkers: 5 },
      ])
    );
    expect(pools).toEqual([
      {
        name: "default",
        repos: ["https://github.com/acme/a"],
        maxWorkers: undefined,
      },
      { name: "gpu", repos: [], maxWorkers: 5 },
    ]);
  });

  it("rejects missing, empty and malformed input", () => {
    expect(() => parsePoolsConfig(undefined)).toThrow(/POOLS var is not set/);
    expect(() => parsePoolsConfig("not json")).toThrow(/not valid JSON/);
    expect(() => parsePoolsConfig("[]")).toThrow(/non-empty/);
    expect(() => parsePoolsConfig("{}")).toThrow(/non-empty JSON array/);
  });

  it("rejects invalid pool names and duplicates", () => {
    expect(() => parsePoolsConfig(JSON.stringify([{ name: "" }]))).toThrow(
      /Invalid pool name/
    );
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "has spaces" }]))
    ).toThrow(/Invalid pool name/);
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "a" }, { name: "a" }]))
    ).toThrow(/Duplicate pool name/);
  });

  it("rejects malformed repos and maxWorkers", () => {
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "a", repos: "nope" }]))
    ).toThrow(/repos must be an array/);
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "a", repos: [""] }]))
    ).toThrow(/entries must be URLs/);
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "a", maxWorkers: 0 }]))
    ).toThrow(/positive integer/);
  });
});

describe("parsePositiveInt", () => {
  it("parses valid values and falls back otherwise", () => {
    expect(parsePositiveInt("7", 3)).toBe(7);
    expect(parsePositiveInt(undefined, 3)).toBe(3);
    expect(parsePositiveInt("", 3)).toBe(3);
    expect(parsePositiveInt("-1", 3)).toBe(3);
    expect(parsePositiveInt("2.5", 3)).toBe(3);
  });
});

describe("poolConfigFingerprint", () => {
  it("changes when the repo list changes and ignores repo order", () => {
    const base = { name: "a", repos: ["r1", "r2"] };
    expect(poolConfigFingerprint(base)).toBe(
      poolConfigFingerprint({ name: "a", repos: ["r2", "r1"] })
    );
    expect(poolConfigFingerprint(base)).not.toBe(
      poolConfigFingerprint({ name: "a", repos: ["r1"] })
    );
  });
});
