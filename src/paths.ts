import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The home directory, overridable for tests with AGENT_FENCE_HOME_DIR. */
export function homeDir(): string {
  return process.env.AGENT_FENCE_HOME_DIR || os.homedir();
}

/** Forward slashes only, so globs behave the same on every platform. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Whether paths on this platform should be compared without regard to case. */
export function caseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Where the user-level policy lives. */
export function userPolicyPath(): string {
  if (process.env.AGENT_FENCE_CONFIG) return process.env.AGENT_FENCE_CONFIG;
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
    return path.join(base, "agent-fence", "policy.toml");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(base, "agent-fence", "policy.toml");
}

/** Directory holding the audit log. */
export function stateDir(): string {
  if (process.env.AGENT_FENCE_STATE_DIR) return process.env.AGENT_FENCE_STATE_DIR;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
    return path.join(base, "agent-fence");
  }
  const base = process.env.XDG_STATE_HOME || path.join(homeDir(), ".local", "state");
  return path.join(base, "agent-fence");
}

export const PROJECT_POLICY = ".agent-fence.toml";

/**
 * The project root for a working directory: the nearest ancestor holding a
 * .agent-fence.toml, else the nearest holding .git, else the directory itself.
 */
export function findProjectRoot(start: string): string {
  const abs = path.resolve(start);
  let gitRoot: string | null = null;
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, PROJECT_POLICY))) return dir;
    if (!gitRoot && existsSync(path.join(dir, ".git"))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? abs;
}

/** realpath of the longest existing prefix of p, with the rest appended. */
function realpathLoose(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Expand a leading ~ or $HOME / ${HOME} to the home directory. */
export function expandHome(p: string): string {
  const m = /^(~|\$HOME|\$\{HOME\})(?=$|[\\/])/.exec(p);
  return m ? homeDir() + p.slice(m[0].length) : p;
}

const DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Turn any path an agent hands us into an absolute, normalized, forward-slash
 * path: expands ~, resolves relative to cwd, collapses `..`, treats backslashes
 * as separators, and resolves symlinks for the part of the path that exists.
 */
export function normalizePath(input: string, cwd: string, opts: { resolveSymlinks?: boolean } = {}): string {
  let p = expandHome(input.trim());
  p = toPosix(p);
  const cwdPosix = toPosix(cwd);
  let abs: string;
  if (DRIVE.test(p) || DRIVE.test(cwdPosix)) {
    abs = path.win32.resolve(cwd, p);
  } else {
    abs = path.posix.resolve(cwdPosix, p);
  }
  if (opts.resolveSymlinks !== false && (process.platform === "win32" || !DRIVE.test(abs))) {
    abs = realpathLoose(abs);
  }
  abs = toPosix(abs);
  if (abs.length > 1 && abs.endsWith("/") && !/^[A-Za-z]:\/$/.test(abs)) abs = abs.slice(0, -1);
  return abs;
}

/** True when `child` is `parent` or inside it. Both must be normalized. */
export function isInside(child: string, parent: string, nocase = caseInsensitive()): boolean {
  const c = nocase ? child.toLowerCase() : child;
  const p = nocase ? parent.toLowerCase() : parent;
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : p + "/");
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
