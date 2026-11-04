import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compactionSummary,
  handleCompaction,
  lastUserExcerpt,
  transcriptExcerpt,
  transcriptFilePath,
  writeTranscriptFile,
} from "../src/compaction.js";
import { renderTranscript } from "../src/transcripts.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-memory-retrieval-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const runtime = { dir: "", scope: "/home/u/project" };

const input = {
  sessionID: "ses_1",
  model: "openrouter/z-ai/glm-5.3-flash",
  messages: [
    { role: "user", content: [{ type: "text", text: "Fix the login bug\nsecond line" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "On it." }],
    },
  ],
};

describe("lastUserExcerpt", () => {
  it("returns the last user text as a one-line excerpt", () => {
    const excerpt = lastUserExcerpt(input.messages);
    expect(excerpt).toBe("Fix the login bug second line");
  });

  it("caps the excerpt length", () => {
    const long = "y".repeat(500);
    const excerpt = lastUserExcerpt([{ role: "user", content: [{ type: "text", text: long }] }]);
    expect(excerpt.length).toBe(200);
  });

  it("returns empty when there is no user text", () => {
    expect(lastUserExcerpt([{ role: "assistant", content: [{ type: "text", text: "hi" }] }])).toBe(
      "",
    );
  });

  it("accepts plain string content and honors a custom cap", () => {
    expect(lastUserExcerpt([{ role: "user", content: "one two" }])).toBe("one two");
    expect(
      lastUserExcerpt([{ role: "user", content: [{ type: "text", text: "abcdef" }] }], 3),
    ).toBe("abc");
  });
});

describe("transcriptFilePath", () => {
  it("nests one directory per scope and stays filesystem-safe", () => {
    const path = transcriptFilePath("/data/transcripts", "/home/u/project", "ses_1");
    expect(path).toBe(join("/data/transcripts", encodeURIComponent("/home/u/project"), "ses_1.md"));
  });

  it("neutralizes a traversal session id", () => {
    const path = transcriptFilePath("/data/transcripts", "/home/u/project", "../../evil");
    expect(path.startsWith(join("/data/transcripts", encodeURIComponent("/home/u/project")))).toBe(
      true,
    );
    expect(path).not.toContain("/../");
  });
});

describe("writeTranscriptFile", () => {
  it("writes with restrictive modes and is idempotent", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmpDir();
    const path = join(dir, "scope", "ses_1.md");
    const content = "# Transcript\n";
    writeTranscriptFile(path, content);
    writeTranscriptFile(path, content);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "scope")).mode & 0o777).toBe(0o700);
  });
});

describe("transcriptExcerpt", () => {
  it("takes the first line after the last user heading", () => {
    const dir = tmpDir();
    const path = join(dir, "t.md");
    writeTranscriptFile(
      path,
      "## user\nfirst request\n\n## assistant\nwork\n\n## user\nsecond   request\nhere\n",
    );
    expect(transcriptExcerpt(path)).toBe("second request");
  });

  it("returns empty without a user section", () => {
    const dir = tmpDir();
    const path = join(dir, "t.md");
    writeTranscriptFile(path, "## assistant\nonly work\n");
    expect(transcriptExcerpt(path)).toBe("");
  });
});

describe("compactionSummary", () => {
  it("points at the transcript, names both retrieval tools, and demands retrieval", () => {
    const summary = compactionSummary("/data/t/ses_1.md", "Fix the login bug");
    expect(summary).toContain("/data/t/ses_1.md");
    expect(summary).toContain("Fix the login bug");
    expect(summary).toContain("memory_session_search");
    expect(summary).toContain("memory_session_read");
    expect(summary).toContain("Never guess: retrieve.");
    expect(summary).toContain("memory_save");
  });

  it("stays instructive when the transcript is unavailable", () => {
    const summary = compactionSummary(null, "");
    expect(summary).toContain("unavailable");
    expect(summary).toContain("memory_session_search");
  });
});

describe("handleCompaction", () => {
  it("writes the transcript and returns a pointer summary", () => {
    runtime.dir = tmpDir();
    const { summary, path } = handleCompaction(input, runtime);
    expect(path).not.toBeNull();
    expect(existsSync(path as string)).toBe(true);
    expect(summary).toContain(path as string);
    expect(summary).toContain("Fix the login bug");
    const file = readFileSync(path as string, "utf8");
    expect(file).toBe(
      renderTranscript(input.messages, {
        sessionID: "ses_1",
        scope: "/home/u/project",
        model: "openrouter/z-ai/glm-5.3-flash",
      }),
    );
    expect(file).toContain("Fix the login bug");
  });

  it("is idempotent through the handler", () => {
    runtime.dir = tmpDir();
    const first = handleCompaction(input, runtime);
    const second = handleCompaction(input, runtime);
    expect(second.path).toBe(first.path);
    expect(readFileSync(first.path as string, "utf8")).toBe(
      readFileSync(second.path as string, "utf8"),
    );
  });

  it("skips the file when messages are missing or empty", () => {
    runtime.dir = tmpDir();
    const empty = handleCompaction({ ...input, messages: [] }, runtime);
    expect(empty.path).toBeNull();
    expect(empty.summary).toContain("memory_session_search");

    const missing = handleCompaction(
      { sessionID: "ses_1", messages: undefined as unknown as [] },
      runtime,
    );
    expect(missing.path).toBeNull();
    expect(existsSync(join(runtime.dir, encodeURIComponent("/home/u/project")))).toBe(false);

    const noSession = handleCompaction({ sessionID: "", messages: input.messages }, runtime);
    expect(noSession.path).toBeNull();
    expect(existsSync(join(runtime.dir, encodeURIComponent("/home/u/project")))).toBe(false);
  });
});

describe("file mode boundary", () => {
  it("never loosens an already-restrictive file", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmpDir();
    const path = join(dir, "scope", "ses_1.md");
    writeTranscriptFile(path, "a");
    chmodSync(path, 0o400);
    writeTranscriptFile(path, "b");
    expect(readFileSync(path, "utf8")).toBe("b");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
