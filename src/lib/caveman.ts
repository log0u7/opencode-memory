import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Optional integration with caveman (https://github.com/JuliusBrussee/caveman) and
// its OpenCode ports. When caveman is installed, the agent already speaks in the
// compressed register, so the memory guidance switches to a terse variant and asks
// for terse entries: every stored title and body is re-read on each recall, so a
// shorter entry pays off on every future session. When caveman is absent, nothing
// mentions it: the guidance stays the plain one.
//
// This module must not import a host-provided package (see options.ts).

export type CavemanOption = "auto" | boolean;

/** Marker the upstream installer wraps its always-on rules with in AGENTS.md. */
const AGENTS_MD_MARKER = "<!-- caveman-begin -->";
/** Mode flag the upstream OpenCode plugin keeps while a mode is active (unlinked on off). */
const FLAG_FILE = ".caveman-active";
/** A plugin entry naming caveman or one of its ports (opencode-caveman, caveopen...). */
const PLUGIN_ENTRY = /"[^"\n]*(?:caveman|caveopen)[^"\n]*"/i;

type Env = Record<string, string | undefined>;

/** Same resolution order as OpenCode and the caveman installer:
 * OPENCODE_CONFIG_DIR, then $XDG_CONFIG_HOME/opencode, then ~/.config/opencode. */
export function opencodeConfigDir(env: Env = process.env): string {
  const selected = env.OPENCODE_CONFIG_DIR ?? "";
  if (selected.trim() !== "") {
    return resolve(selected);
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "opencode");
  }
  return join(env.HOME ?? homedir(), ".config", "opencode");
}

function fileContains(path: string, needle: string | RegExp): boolean {
  try {
    if (!existsSync(path)) {
      return false;
    }
    const text = readFileSync(path, "utf8");
    return typeof needle === "string" ? text.includes(needle) : needle.test(text);
  } catch {
    return false;
  }
}

/**
 * Best-effort detection, read once at plugin boot (restart OpenCode after installing
 * or removing caveman). Any of these signals counts:
 * - the upstream mode flag `<config>/.caveman-active`;
 * - the upstream always-on block in `<config>/AGENTS.md`, or in the project's
 *   `AGENTS.md` / `.opencode/AGENTS.md` (`--with-init`);
 * - a `plugin` entry naming caveman in `<config>/opencode.json(c)` or the project's
 *   `opencode.json(c)` (third-party ports).
 * Never throws: an unreadable file is simply not a signal.
 */
export function detectCaveman(directory?: string, env: Env = process.env): boolean {
  const config = opencodeConfigDir(env);
  if (existsSync(join(config, FLAG_FILE))) {
    return true;
  }
  const agentsFiles = [join(config, "AGENTS.md")];
  const configFiles = [join(config, "opencode.json"), join(config, "opencode.jsonc")];
  if (directory !== undefined) {
    agentsFiles.push(join(directory, "AGENTS.md"), join(directory, ".opencode", "AGENTS.md"));
    configFiles.push(join(directory, "opencode.json"), join(directory, "opencode.jsonc"));
  }
  return (
    agentsFiles.some((path) => fileContains(path, AGENTS_MD_MARKER)) ||
    configFiles.some((path) => fileContains(path, PLUGIN_ENTRY))
  );
}

/** `true`/`false` force the mode; anything else (absent, "auto", junk) detects. */
export function resolveCaveman(
  option: unknown,
  directory?: string,
  env: Env = process.env,
): boolean {
  if (option === true || option === false) {
    return option;
  }
  return detectCaveman(directory, env);
}
