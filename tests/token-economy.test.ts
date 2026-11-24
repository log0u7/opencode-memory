import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import { forget, save } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

const SCOPE = "/work/project";

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: SCOPE,
    kind: "fact",
    title: "entry",
    body: "some body",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

describe("token economy", () => {
  it("serves a long body as a bounded preview carrying its real length", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = "lorem ipsum dolor sit amet ".repeat(120).slice(0, 3000);
    save(db, input({ title: "long note", body }));

    const out = ops.search({ query: "long note" }, SCOPE);
    const line = out.split("\n")[1] ?? "";
    expect(line).toContain("truncated:3000");
    const preview = line.slice(line.indexOf(" — ") + 3).replace(/ · truncated:\d+$/, "");
    expect(preview.length).toBeLessThanOrEqual(505);
    db.close();
  });

  it("serves a short body in full without the truncated marker", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = "complete but small".padEnd(300, ".");
    save(db, input({ title: "short note", body }));

    const line = ops.search({ query: "short note" }, SCOPE).split("\n")[1] ?? "";
    expect(line).toMatch(/ fact short note — complete but small\.+$/);
    expect(line).not.toContain("truncated");
    db.close();
  });

  it("cuts the preview on a word boundary, never mid-word", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = `one two three ${"z".repeat(2000)}`;
    save(db, input({ title: "word boundary", body }));

    const line = ops.search({ query: "word boundary" }, SCOPE).split("\n")[1] ?? "";
    const preview = line.slice(line.indexOf(" — ") + 3).replace(/ · truncated:\d+$/, "");
    expect(preview.endsWith("…")).toBe(true);
    const head = preview.slice(0, -1);
    expect(body.startsWith(head)).toBe(true);
    // The character right after the kept prefix is a break, not a letter.
    expect(body.slice(head.length)).toMatch(/^\s/);
    db.close();
  });

  it("memory_get returns the complete entry whatever the preview cut", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = "lorem ipsum dolor sit amet ".repeat(120).slice(0, 3000);
    const entry = save(
      db,
      input({
        kind: "lesson",
        title: "long note",
        body,
        paths: ["src/lib/store.ts"],
        commit_sha: "a".repeat(7),
        source: "tester",
      }),
    );

    const full = ops.get({ id: entry.id });
    expect(full.startsWith(body)).toBe(true);
    expect(full).toContain(`\n—\nid ${entry.id} · lesson · just now · heat 1`);
    expect(full).toContain("\npaths: src/lib/store.ts");
    db.close();
  });

  it("memory_get tells a trashed entry from an unknown id", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const entry = save(db, input({ title: "doomed note" }));

    expect(ops.get({ id: "00000000-0000-0000-0000-000000000000" })).toBe("no entry with that id");
    forget(db, { id: entry.id });
    expect(ops.get({ id: entry.id })).toBe(
      "entry is in the trash (restorable for 30 days): use memory_restore to put it back",
    );
    db.close();
  });
});
