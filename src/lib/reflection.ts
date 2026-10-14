/**
 * Optional end-of-turn reflection: distills durable lessons from a session tail with
 * one bounded LLM call and saves them as `lesson` entries. Best-effort by design:
 * a disabled config wires nothing, a failing run is swallowed, and each session is
 * reflected at most once.
 */

export type ReflectionConfig = {
  enabled: boolean;
  model?: string | undefined;
  maxLessons: number;
  transcriptChars: number;
};

export type ReflectionDeps = {
  isSubagent: (sessionID: string) => Promise<boolean>;
  transcript: (sessionID: string) => Promise<string>;
  generate: (prompt: string, sessionID: string) => Promise<string>;
  saveLesson: (title: string, body: string) => void;
};

const MAX_LESSONS_DEFAULT = 3;
const MAX_LESSONS_CAP = 10;
const TRANSCRIPT_CHARS_DEFAULT = 8000;
const TRANSCRIPT_CHARS_MIN = 500;
const TRANSCRIPT_CHARS_MAX = 50000;
/** Below this much transcript there is nothing to distill; saves the LLM call. */
const TRANSCRIPT_MIN_CHARS = 256;
const MAX_TRACKED = 512;

export function parseReflectionConfig(raw: unknown): ReflectionConfig | null {
  if (raw === null || typeof raw !== "object" || (raw as { enabled?: unknown }).enabled !== true) {
    return null;
  }
  const rawConfig = raw as { model?: unknown; maxLessons?: unknown; transcriptChars?: unknown };
  return {
    enabled: true,
    model:
      typeof rawConfig.model === "string" && rawConfig.model.includes("/")
        ? rawConfig.model
        : undefined,
    maxLessons: clamp(rawConfig.maxLessons, 1, MAX_LESSONS_CAP, MAX_LESSONS_DEFAULT),
    transcriptChars: clamp(
      rawConfig.transcriptChars,
      TRANSCRIPT_CHARS_MIN,
      TRANSCRIPT_CHARS_MAX,
      TRANSCRIPT_CHARS_DEFAULT,
    ),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function distillPrompt(transcript: string, maxLessons: number): string {
  return (
    `You are the persistent-memory reflection for this project's OpenCode sessions. Below is the tail of one ` +
    `coding session transcript. Extract at most ${maxLessons} durable, reusable lessons: non-obvious approaches ` +
    `that clearly failed and why, non-obvious approaches that clearly worked and why, or constraints discovered ` +
    `the hard way. Exclude anything trivially re-derivable from the code, anything session-specific, and any ` +
    `credential. Reply with ONLY a JSON array, no markdown fences and no prose: ` +
    `[{"title": "max 120 chars", "body": "the lesson, max 8000 chars"}]. Reply [] when nothing qualifies.\n\n` +
    `SESSION TRANSCRIPT:\n${transcript}`
  );
}

export function parseLessons(text: string, max: number): Array<{ title: string; body: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = text
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();
    try {
      parsed = JSON.parse(fenced);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const lessons: Array<{ title: string; body: string }> = [];
  for (const item of parsed.slice(0, max)) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const { title, body } = item as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) {
      continue;
    }
    lessons.push({ title: title.slice(0, 120), body: body.slice(0, 8000) });
  }
  return lessons;
}

export function createReflection(
  config: ReflectionConfig,
  deps: ReflectionDeps,
): (sessionID: string | undefined) => void {
  const done = new Set<string>();
  const inFlight = new Set<string>();

  const run = async (sessionID: string) => {
    try {
      if (await deps.isSubagent(sessionID)) {
        return;
      }
      const tail = (await deps.transcript(sessionID)).slice(-config.transcriptChars);
      if (tail.length < Math.min(TRANSCRIPT_MIN_CHARS, config.transcriptChars)) {
        return;
      }
      const reply = await deps.generate(distillPrompt(tail, config.maxLessons), sessionID);
      for (const lesson of parseLessons(reply, config.maxLessons)) {
        deps.saveLesson(lesson.title, lesson.body);
      }
    } catch {
      // Reflection is best-effort: never surface a failure to the host.
    } finally {
      inFlight.delete(sessionID);
      done.add(sessionID);
      if (done.size > MAX_TRACKED) {
        done.clear();
      }
    }
  };

  return (sessionID) => {
    if (!sessionID || !config.enabled || done.has(sessionID) || inFlight.has(sessionID)) {
      return;
    }
    inFlight.add(sessionID);
    void run(sessionID);
  };
}
