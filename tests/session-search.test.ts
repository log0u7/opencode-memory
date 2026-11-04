import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTranscriptFile } from "../src/compaction.js";
import { readTranscript, searchTranscripts } from "../src/session-search.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-memory-search-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const SCOPE = "/home/u/project";

function seed(dir: string, sessionID: string, body: string): string {
  const path = join(dir, encodeURIComponent(SCOPE), `${sessionID}.md`);
  writeTranscriptFile(path, body);
  return path;
}

const transcriptA = [
  "# Transcript ses_a",
  "scope: /home/u/project",
  "model: m",
  "",
  "## user",
  "Fix the login bug",
  "",
  "## assistant",
  "On it.",
  "### tool-result shell (id c1)",
  "~~~",
  "Error: ENOENT at /etc/missing.conf",
  "~~~",
  "",
].join("\n");

const transcriptB = [
  "# Transcript ses_b",
  "scope: /home/u/project",
  "model: m",
  "",
  "## user",
  "PORT=5432 for the replica",
  "",
].join("\n");

describe("searchTranscripts", () => {
  it("finds matches with context across the scope, newest file first", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const pathB = seed(dir, "ses_b", transcriptB);

    const out = searchTranscripts(dir, SCOPE, { query: "error" });
    expect(out).toContain("ses_a.md:12: Error: ENOENT at /etc/missing.conf");
    expect(out).toContain("~~~");
    expect(out).not.toContain(pathB);
  });

  it("matches case-insensitively", () => {
    const dir = tmpDir();
    seed(dir, "ses_b", transcriptB);
    const out = searchTranscripts(dir, SCOPE, { query: "port=5432" });
    expect(out).toContain("PORT=5432");
  });

  it("targets one session when sessionID is given", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    seed(dir, "ses_b", transcriptB);
    const out = searchTranscripts(dir, SCOPE, { query: "user", sessionID: "ses_b" });
    expect(out).toContain("ses_b.md");
    expect(out).not.toContain("ses_a.md");
  });

  it("finds sessions whose id needs percent-encoding", () => {
    const dir = tmpDir();
    const tricky = "a b/c";
    writeTranscriptFile(
      join(dir, encodeURIComponent(SCOPE), `${encodeURIComponent(tricky)}.md`),
      "## user\ntricky id content\n",
    );
    const found = searchTranscripts(dir, SCOPE, { query: "tricky", sessionID: tricky });
    expect(found).toContain("tricky id content");
    const read = readTranscript(dir, SCOPE, { sessionID: tricky, limit: 5 });
    expect(read).toContain("tricky id content");
  });

  it("caps the output size and says so", () => {
    const dir = tmpDir();
    const lines = Array.from({ length: 200 }, (_, i) => `hit line ${i} needle`).join("\n");
    seed(dir, "ses_big", `## x\n${lines}`);
    const out = searchTranscripts(dir, SCOPE, { query: "needle", maxBytes: 2000 });
    expect(out.length).toBeLessThan(2400);
    expect(out).toContain("[output capped");
  });

  it("clamps an oversized byte cap to the tool ceiling", () => {
    const dir = tmpDir();
    seed(
      dir,
      "ses_big",
      `## x\n${Array.from({ length: 500 }, (_, i) => `hit line ${i} needle`).join("\n")}`,
    );
    const out = searchTranscripts(dir, SCOPE, { query: "needle", maxBytes: 500000 });
    expect(out.length).toBeLessThanOrEqual(100500);
  });

  it("skips symlinks instead of following them", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmpDir();
    const scopeDir = join(dir, encodeURIComponent(SCOPE));
    mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
    const target = join(dir, "symlink-target.md");
    writeTranscriptFile(target, "## user\nsecret via link\n");
    symlinkSync(target, join(scopeDir, "evil.md"));
    const out = searchTranscripts(dir, SCOPE, { query: "secret" });
    expect(out).not.toContain("secret via link");
    expect(out).toContain("no transcript");
    expect(readTranscript(dir, SCOPE, { sessionID: "evil" })).toContain("no transcript");
  });

  it("reports a clean miss", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const out = searchTranscripts(dir, SCOPE, { query: "nonexistent-thing" });
    expect(out).toContain("no match");
  });

  it("lists available sessions when the requested one is missing", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const out = searchTranscripts(dir, SCOPE, { query: "error", sessionID: "ses_zzz" });
    expect(out).toContain("ses_zzz");
    expect(out).toContain("ses_a.md");
  });

  it("says when no transcript exists at all", () => {
    const dir = tmpDir();
    const out = searchTranscripts(dir, SCOPE, { query: "anything" });
    expect(out).toContain("no transcript");
  });

  it("searches every scope with all: true", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const otherScope = "/home/u/other";
    writeTranscriptFile(
      join(dir, encodeURIComponent(otherScope), "ses_o.md"),
      "## user\nneedle in another project\n",
    );
    expect(searchTranscripts(dir, SCOPE, { query: "needle" })).toContain("no match");
    const everything = searchTranscripts(dir, SCOPE, { query: "needle", all: true });
    expect(everything).toContain("/home/u/other/ses_o.md:");
    expect(everything).toContain("needle in another project");
  });
});

describe("readTranscript", () => {
  it("returns a numbered window with defaults", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const out = readTranscript(dir, SCOPE, { sessionID: "ses_a", offset: 10, limit: 4 });
    expect(out).toContain("10: ### tool-result shell (id c1)");
    expect(out).toContain("11: ~~~");
    expect(out).toContain("12: Error: ENOENT at /etc/missing.conf");
    expect(out).not.toContain("1: # Transcript");
  });

  it("caps the window and reports the end of file", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    expect(readTranscript(dir, SCOPE, { sessionID: "ses_a", limit: 5000 })).toContain(
      "[window capped at 500 lines]",
    );
    expect(readTranscript(dir, SCOPE, { sessionID: "ses_a", offset: 9999 })).toContain(
      "end of transcript",
    );
  });

  it("reports a missing session with what exists", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const out = readTranscript(dir, SCOPE, { sessionID: "ses_zzz" });
    expect(out).toContain("ses_zzz");
    expect(out).toContain("ses_a.md");
  });

  it("treats a NaN offset as the beginning", () => {
    const dir = tmpDir();
    seed(dir, "ses_a", transcriptA);
    const out = readTranscript(dir, SCOPE, {
      sessionID: "ses_a",
      offset: Number.NaN,
      limit: 1,
    });
    expect(out).toContain("1: # Transcript");
  });
});
