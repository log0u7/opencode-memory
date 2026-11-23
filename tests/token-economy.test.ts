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

    const hits = JSON.parse(ops.search({ query: "long note" }, SCOPE)) as Array<
      Record<string, unknown>
    >;
    expect(hits).toHaveLength(1);
    const hit = hits[0] as { body: string; truncated?: number };
    expect(hit.body.length).toBeLessThanOrEqual(505);
    expect(hit.truncated).toBe(body.length);
    db.close();
  });

  it("serves a short body in full without the truncated marker", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = "complete but small".padEnd(300, ".");
    save(db, input({ title: "short note", body }));

    const hits = JSON.parse(ops.search({ query: "short note" }, SCOPE)) as Array<
      Record<string, unknown>
    >;
    const hit = hits[0] as { body: string; truncated?: number };
    expect(hit.body).toBe(body);
    expect(hit.truncated).toBeUndefined();
    db.close();
  });

  it("cuts the preview on a word boundary, never mid-word", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const body = `one two three ${"z".repeat(2000)}`;
    save(db, input({ title: "word boundary", body }));

    const hits = JSON.parse(ops.search({ query: "word boundary" }, SCOPE)) as Array<
      Record<string, unknown>
    >;
    const preview = (hits[0] as { body: string }).body;
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

    const full = JSON.parse(ops.get({ id: entry.id })) as Record<string, unknown>;
    expect(full.body).toBe(body);
    expect(full.paths).toEqual(["src/lib/store.ts"]);
    expect(full.commit_sha).toBe("a".repeat(7));
    expect(full.heat).toBe(1);
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
