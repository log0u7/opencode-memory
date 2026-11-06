import { describe, expect, it } from "vitest";

import { formatMemoryDialog, formatMemoryLine, snapshotFromStats } from "../src/rpc.js";

describe("snapshotFromStats", () => {
  it("totals the kind counts and keeps the store size", () => {
    const s = snapshotFromStats(
      [
        { kind: "decision", count: 12 },
        { kind: "fact", count: 8 },
        { kind: "lesson", count: 3 },
      ],
      1_200_000,
    );
    expect(s.total).toBe(23);
    expect(s.store_bytes).toBe(1_200_000);
    expect(s.top_kinds).toEqual(["decision: 12", "fact: 8", "lesson: 3"]);
    expect(s.all_kinds).toEqual(["decision: 12", "fact: 8", "lesson: 3"]);
  });

  it("keeps the full kind breakdown beyond the top 3", () => {
    const s = snapshotFromStats(
      [
        { kind: "decision", count: 12 },
        { kind: "fact", count: 8 },
        { kind: "lesson", count: 3 },
        { kind: "gotcha", count: 2 },
        { kind: "preference", count: 1 },
      ],
      1_200_000,
    );
    expect(s.top_kinds).toEqual(["decision: 12", "fact: 8", "lesson: 3"]);
    expect(s.all_kinds).toEqual([
      "decision: 12",
      "fact: 8",
      "lesson: 3",
      "gotcha: 2",
      "preference: 1",
    ]);
  });

  it("reports zero entries for an empty store", () => {
    const s = snapshotFromStats([], 4096);
    expect(s.total).toBe(0);
    expect(s.top_kinds).toEqual([]);
    expect(s.store_bytes).toBe(4096);
  });
});

describe("formatMemoryLine", () => {
  it("renders entries, size and the top kinds", () => {
    const line = formatMemoryLine({
      total: 23,
      store_bytes: 1_200_000,
      top_kinds: ["decision: 12", "fact: 8"],
      all_kinds: ["decision: 12", "fact: 8"],
    });
    expect(line).toBe("memory: 23 entries · 1.1 MB · decision: 12, fact: 8");
  });

  it("stays null for an empty store", () => {
    expect(
      formatMemoryLine({ total: 0, store_bytes: 4096, top_kinds: [], all_kinds: [] }),
    ).toBeNull();
  });
});

describe("formatMemoryDialog", () => {
  it("renders the full breakdown, one line per kind, and the size", () => {
    const lines = formatMemoryDialog({
      total: 26,
      store_bytes: 1_200_000,
      top_kinds: ["decision: 12", "fact: 8", "lesson: 3"],
      all_kinds: ["decision: 12", "fact: 8", "lesson: 3", "gotcha: 2", "preference: 1"],
    });
    expect(lines).toEqual([
      "memory: 26 entries · 1.1 MB",
      "decision: 12",
      "fact: 8",
      "lesson: 3",
      "gotcha: 2",
      "preference: 1",
    ]);
  });

  it("shows the header only for an empty store", () => {
    const lines = formatMemoryDialog({ total: 0, store_bytes: 4096, top_kinds: [], all_kinds: [] });
    expect(lines).toEqual(["memory: 0 entries · 4 kB"]);
  });
});
