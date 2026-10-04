import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { homeDir } from "./paths.js";

export type Agent = "claude" | "codex";

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/** Tool names the PreToolUse hook is registered for. */
export const CLAUDE_MATCHER = "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Glob|Grep|LS|WebFetch";
export const CODEX_MATCHER = "Bash|apply_patch|Edit|Write|Read";

const MARKER = /agent-fence.*\bhook (claude|codex)\b/;

export interface HookTarget {
  agent: Agent;
  file: string;
  scope: "local" | "shared" | "user" | "project";
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(homeDir(), ".codex");
}

export function hookTarget(agent: Agent, root: string, opts: { shared?: boolean; project?: boolean } = {}): HookTarget {
  if (agent === "claude") {
    return opts.shared
      ? { agent, file: path.join(root, ".claude", "settings.json"), scope: "shared" }
      : { agent, file: path.join(root, ".claude", "settings.local.json"), scope: "local" };
  }
  return opts.project
    ? { agent, file: path.join(root, ".codex", "hooks.json"), scope: "project" }
    : { agent, file: path.join(codexHome(), "hooks.json"), scope: "user" };
}

export function allHookTargets(agent: Agent, root: string): HookTarget[] {
  return agent === "claude"
    ? [hookTarget(agent, root), hookTarget(agent, root, { shared: true })]
    : [hookTarget(agent, root), hookTarget(agent, root, { project: true })];
}

function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function runningFromNpxCache(): boolean {
  return /[\\/]_npx[\\/]/.test(process.argv[1] || "");
}

/**
 * The base command written into hook settings: `agent-fence` when it is on PATH
 * (and not npx's temporary shim), otherwise node plus the absolute path of this
 * script.
 */
export function defaultBaseCommand(): string {
  const onPath = findOnPath("agent-fence");
  if (onPath && !/[\\/]_npx[\\/]/.test(onPath)) return "agent-fence";
  const script = (process.argv[1] || "agent-fence").replace(/\\/g, "/");
  return `node "${script}"`;
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, so agent-fence left it unchanged. Fix it and retry. (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object, so agent-fence left it unchanged.`);
  }
  const s = parsed as Settings;
  if (s.hooks !== undefined && (typeof s.hooks !== "object" || s.hooks === null || Array.isArray(s.hooks))) {
    throw new Error(`"hooks" in ${file} is not an object, so agent-fence left it unchanged.`);
  }
  if (s.hooks?.PreToolUse !== undefined && !Array.isArray(s.hooks.PreToolUse)) {
    throw new Error(`hooks.PreToolUse in ${file} is not an array, so agent-fence left it unchanged.`);
  }
  return s;
}

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let dest = `${file}.agent-fence-backup-${stamp}`;
  for (let i = 1; existsSync(dest); i++) dest = `${file}.agent-fence-backup-${stamp}-${i}`;
  copyFileSync(file, dest);
  return dest;
}

const isOurs = (h: HookEntry) => typeof h.command === "string" && MARKER.test(h.command);

function strip(groups: HookGroup[]): { kept: HookGroup[]; removed: number } {
  let removed = 0;
  const kept: HookGroup[] = [];
  for (const g of groups) {
    const inner = (g.hooks ?? []).filter((h) => !isOurs(h));
    const n = (g.hooks?.length ?? 0) - inner.length;
    removed += n;
    if (n === 0) kept.push(g);
    else if (inner.length) kept.push({ ...g, hooks: inner });
  }
  return { kept, removed };
}

export interface InstallResult {
  file: string;
  command: string;
  changed: boolean;
  created: boolean;
  backup?: string;
}

/**
 * Add a PreToolUse hook for agent-fence, keeping every other setting and hook.
 * An earlier agent-fence entry is replaced; the file is backed up before any write.
 */
export function installHook(target: HookTarget, base = defaultBaseCommand()): InstallResult {
  const command = `${base} hook ${target.agent}`;
  const settings = readSettings(target.file);
  const created = !existsSync(target.file);
  const hooks = (settings.hooks ??= {});
  const existing = hooks.PreToolUse ?? [];
  const already = existing.some(
    (g) => g.matcher === (target.agent === "claude" ? CLAUDE_MATCHER : CODEX_MATCHER) && g.hooks?.some((h) => h.command === command),
  );
  if (already) return { file: target.file, command, changed: false, created: false };
  const { kept } = strip(existing);
  const entry: HookEntry = { type: "command", command, timeout: 30 };
  if (target.agent === "codex") entry.statusMessage = "agent-fence policy check";
  hooks.PreToolUse = [...kept, { matcher: target.agent === "claude" ? CLAUDE_MATCHER : CODEX_MATCHER, hooks: [entry] }];
  const bak = backup(target.file);
  mkdirSync(path.dirname(target.file), { recursive: true });
  writeFileSync(target.file, JSON.stringify(settings, null, 2) + "\n");
  return { file: target.file, command, changed: true, created, backup: bak };
}

export function uninstallHook(target: HookTarget): { file: string; removed: number; backup?: string } {
  if (!existsSync(target.file)) return { file: target.file, removed: 0 };
  const settings = readSettings(target.file);
  const hooks = settings.hooks;
  let removed = 0;
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const r = strip(hooks[event]);
      removed += r.removed;
      if (r.kept.length) hooks[event] = r.kept;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete settings.hooks;
  }
  if (!removed) return { file: target.file, removed };
  const bak = backup(target.file);
  writeFileSync(target.file, JSON.stringify(settings, null, 2) + "\n");
  return { file: target.file, removed, backup: bak };
}

export function hookInstalled(target: HookTarget): boolean | string {
  try {
    const s = readSettings(target.file);
    return Object.values(s.hooks ?? {}).some((gs) => Array.isArray(gs) && gs.some((g) => g.hooks?.some(isOurs)));
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Whether Codex has recorded trust for our PreToolUse hook in this hooks.json.
 * Codex keeps it in config.toml as [hooks.state."<hooks.json>:pre_tool_use:<group>:<hook>"]
 * with a trusted_hash; a changed entry needs trusting again, which this cannot verify.
 */
export function codexHookTrusted(target: HookTarget): boolean {
  try {
    const settings = readSettings(target.file);
    const groups = settings.hooks?.PreToolUse ?? [];
    const keys: string[] = [];
    groups.forEach((g, gi) => (g.hooks ?? []).forEach((h, hi) => isOurs(h) && keys.push(`${target.file}:pre_tool_use:${gi}:${hi}`)));
    if (!keys.length) return false;
    const cfg = parseToml(readFileSync(path.join(codexHome(), "config.toml"), "utf8")) as { hooks?: { state?: Record<string, { trusted_hash?: unknown }> } };
    const state = cfg.hooks?.state ?? {};
    return keys.every((k) => typeof state[k]?.trusted_hash === "string");
  } catch {
    return false;
  }
}
