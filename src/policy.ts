import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { BUILTIN_POLICY } from "./defaults.js";
import { compileCommandPattern, compilePathPattern, literalLength, type CommandPattern, type PathPattern } from "./match.js";
import { PROJECT_POLICY, findProjectRoot, normalizePath, toPosix, userPolicyPath } from "./paths.js";

export type Action = "allow" | "ask" | "deny";
export type Tool = "bash" | "read" | "write" | "fetch";
export type Layer = "builtin" | "user" | "project";

export const ACTIONS: readonly Action[] = ["allow", "ask", "deny"];
export const TOOLS: readonly Tool[] = ["bash", "read", "write", "fetch"];
export const LAYERS: readonly Layer[] = ["builtin", "user", "project"];

export function severity(a: Action): number {
  return a === "deny" ? 2 : a === "ask" ? 1 : 0;
}

export interface RuleSpec {
  id: string;
  action: Action;
  reason: string;
  tool?: Tool | Tool[];
  command?: string | string[];
  command_regex?: string;
  path?: string | string[];
  outside_project?: boolean;
  secrets?: boolean;
  url?: string | string[];
  piped_input?: boolean;
  dynamic?: boolean;
  priority?: number;
  locked?: boolean;
}

export interface Rule {
  id: string;
  action: Action;
  reason: string;
  tools: Tool[];
  layer: Layer;
  file: string;
  priority: number;
  locked: boolean;
  spec: RuleSpec;
  commands?: CommandPattern[];
  commandRegex?: { re: RegExp; specificity: number };
  paths?: PathPattern[];
  urls?: { source: string; re: RegExp; specificity: number }[];
  outsideProject?: boolean;
  secrets?: boolean;
  pipedInput?: boolean;
  dynamic?: boolean;
}

export interface PolicyTest {
  name?: string;
  tool: Tool;
  input?: string;
  path?: string;
  content?: string;
  url?: string;
  cwd?: string;
  expect: Action;
  rule?: string;
  file: string;
  layer: Layer;
}

export interface Defaults {
  bash: Action;
  read: Action;
  write: Action;
  fetch: Action;
  unparsable: Action;
}

export interface Policy {
  root: string;
  rules: Rule[];
  defaults: Defaults;
  /** Where each default came from. */
  defaultsFrom: Record<keyof Defaults, Layer>;
  tests: PolicyTest[];
  files: { layer: Layer; file: string; loaded: boolean }[];
  /** Rules removed by `disable` or replaced by a same-id rule in a later layer. */
  overridden: { rule: Rule; by: string }[];
}

export class PolicyError extends Error {}

const RULE_KEYS = new Set([
  "id", "action", "reason", "tool", "command", "command_regex", "path", "outside_project", "secrets", "url", "piped_input", "dynamic", "priority", "locked",
]);
const TEST_KEYS = new Set(["name", "tool", "input", "path", "content", "url", "cwd", "expect", "rule"]);
const TOP_KEYS = new Set(["version", "defaults", "rules", "tests", "disable"]);

function asList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new PolicyError(`${what} must be a string or a list of strings`);
}

function checkAction(v: unknown, where: string): Action {
  if (typeof v !== "string" || !ACTIONS.includes(v as Action)) {
    throw new PolicyError(`${where}: action must be one of allow, ask, deny (got ${JSON.stringify(v)})`);
  }
  return v as Action;
}

function compileRule(spec: Record<string, unknown>, layer: Layer, file: string, root: string, index: number): Rule {
  const where = `${file}: rule ${typeof spec.id === "string" ? `"${spec.id}"` : `#${index + 1}`}`;
  for (const k of Object.keys(spec)) {
    if (!RULE_KEYS.has(k)) throw new PolicyError(`${where}: unknown key "${k}"`);
  }
  if (typeof spec.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.id)) {
    throw new PolicyError(`${where}: id must be a non-empty string of letters, digits, ".", "_" or "-"`);
  }
  const action = checkAction(spec.action, where);
  if (typeof spec.reason !== "string" || !spec.reason.trim()) {
    throw new PolicyError(`${where}: reason is required; it is what the agent is shown`);
  }
  const s = spec as unknown as RuleSpec;
  const matchers = ["command", "command_regex", "path", "outside_project", "secrets", "url", "dynamic"].filter(
    (k) => spec[k] !== undefined && spec[k] !== false,
  );
  if (matchers.length === 0) throw new PolicyError(`${where}: needs a matcher (command, command_regex, path, outside_project, secrets, url or dynamic)`);
  if (matchers.length > 1) throw new PolicyError(`${where}: use one matcher per rule (found ${matchers.join(", ")})`);
  const kind = matchers[0];
  const toolsGiven = asList(spec.tool, `${where}: tool`);
  for (const t of toolsGiven) if (!TOOLS.includes(t as Tool)) throw new PolicyError(`${where}: unknown tool "${t}" (use ${TOOLS.join(", ")})`);
  const inferred: Record<string, Tool[]> = {
    command: ["bash"],
    command_regex: ["bash"],
    dynamic: ["bash"],
    path: ["read", "write"],
    outside_project: ["read", "write"],
    secrets: ["bash", "write"],
    url: ["fetch"],
  };
  const tools = (toolsGiven.length ? toolsGiven : inferred[kind]) as Tool[];
  const allowed = inferred[kind].concat(kind === "secrets" ? [] : []);
  for (const t of tools) {
    if (!allowed.includes(t)) throw new PolicyError(`${where}: a ${kind} matcher cannot apply to tool "${t}"`);
  }
  if (spec.priority !== undefined && (typeof spec.priority !== "number" || !Number.isFinite(spec.priority))) {
    throw new PolicyError(`${where}: priority must be a number`);
  }
  if (spec.piped_input !== undefined && kind !== "command" && kind !== "command_regex") {
    throw new PolicyError(`${where}: piped_input only works with a command matcher`);
  }
  const rule: Rule = {
    id: s.id,
    action,
    reason: s.reason.trim(),
    tools,
    layer,
    file,
    priority: (spec.priority as number) ?? 0,
    locked: spec.locked === true,
    spec: s,
    pipedInput: spec.piped_input === true,
  };
  try {
    if (kind === "command") rule.commands = asList(spec.command, `${where}: command`).map(compileCommandPattern);
    if (kind === "command_regex") {
      if (typeof spec.command_regex !== "string") throw new PolicyError(`${where}: command_regex must be a string`);
      rule.commandRegex = { re: new RegExp(spec.command_regex), specificity: spec.command_regex.replace(/\\.|[^A-Za-z0-9 _/-]/g, "").length };
    }
    if (kind === "path") rule.paths = asList(spec.path, `${where}: path`).map((p) => compilePathPattern(p, root));
    if (kind === "url") {
      rule.urls = asList(spec.url, `${where}: url`).map((u) => ({
        source: u,
        re: new RegExp("^" + u.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"),
        specificity: literalLength(u),
      }));
    }
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    throw new PolicyError(`${where}: ${(e as Error).message}`);
  }
  if (kind === "outside_project") rule.outsideProject = true;
  if (kind === "secrets") rule.secrets = true;
  if (kind === "dynamic") rule.dynamic = true;
  return rule;
}

interface RawFile {
  version?: number;
  defaults?: Record<string, unknown>;
  rules?: Record<string, unknown>[];
  tests?: Record<string, unknown>[];
  disable?: string[];
}

function parseFile(text: string, file: string): RawFile {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new PolicyError(`${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.has(k)) throw new PolicyError(`${file}: unknown top-level key "${k}" (did you mean [[rules]]?)`);
  }
  if (data.version !== undefined && data.version !== 1) throw new PolicyError(`${file}: unsupported version ${String(data.version)}`);
  if (data.rules !== undefined && !Array.isArray(data.rules)) throw new PolicyError(`${file}: rules must be written as [[rules]] tables`);
  if (data.tests !== undefined && !Array.isArray(data.tests)) throw new PolicyError(`${file}: tests must be written as [[tests]] tables`);
  return {
    version: data.version as number | undefined,
    defaults: data.defaults as Record<string, unknown> | undefined,
    rules: data.rules as Record<string, unknown>[] | undefined,
    tests: data.tests as Record<string, unknown>[] | undefined,
    disable: asList(data.disable, `${file}: disable`),
  };
}

function compileTest(t: Record<string, unknown>, layer: Layer, file: string, i: number): PolicyTest {
  const where = `${file}: test #${i + 1}${typeof t.name === "string" ? ` (${t.name})` : ""}`;
  for (const k of Object.keys(t)) if (!TEST_KEYS.has(k)) throw new PolicyError(`${where}: unknown key "${k}"`);
  if (typeof t.tool !== "string" || !TOOLS.includes(t.tool as Tool)) throw new PolicyError(`${where}: tool must be one of ${TOOLS.join(", ")}`);
  const expect = checkAction(t.expect, where);
  const tool = t.tool as Tool;
  if (tool === "bash" && typeof t.input !== "string") throw new PolicyError(`${where}: a bash test needs input = "<command>"`);
  if ((tool === "read" || tool === "write") && typeof t.path !== "string") throw new PolicyError(`${where}: a ${tool} test needs path = "<path>"`);
  if (tool === "fetch" && typeof t.url !== "string") throw new PolicyError(`${where}: a fetch test needs url = "<url>"`);
  return { ...(t as object), tool, expect, file, layer } as PolicyTest;
}

export interface LoadOptions {
  cwd?: string;
  root?: string;
  /** Override the user policy path; null to skip it. */
  userFile?: string | null;
  /** Skip the project policy file. */
  noProject?: boolean;
  /**
   * Use this file as the project policy instead of <root>/.agent-fence.toml. The
   * project root becomes the directory that holds it, unless root is given.
   */
  projectFile?: string;
}

/** Load builtin, user and project layers and merge them. */
export function loadPolicy(opts: LoadOptions = {}): Policy {
  const cwd = opts.cwd ?? process.cwd();
  const projectFile = opts.projectFile ? path.resolve(cwd, opts.projectFile) : undefined;
  if (projectFile && !existsSync(projectFile)) throw new PolicyError(`${projectFile}: policy file not found`);
  const root = normalizePath(opts.root ?? (projectFile ? path.dirname(projectFile) : findProjectRoot(cwd)), cwd);
  const layers: { layer: Layer; file: string; text: string | null }[] = [{ layer: "builtin", file: "(built-in)", text: BUILTIN_POLICY }];
  const userFile = opts.userFile === undefined ? userPolicyPath() : opts.userFile;
  if (userFile) layers.push({ layer: "user", file: userFile, text: existsSync(userFile) ? readFileSync(userFile, "utf8") : null });
  if (!opts.noProject) {
    const pf = projectFile ?? path.join(root, PROJECT_POLICY);
    layers.push({ layer: "project", file: pf, text: existsSync(pf) ? readFileSync(pf, "utf8") : null });
  }

  const defaults: Defaults = { bash: "allow", read: "allow", write: "allow", fetch: "allow", unparsable: "ask" };
  const defaultsFrom = { bash: "builtin", read: "builtin", write: "builtin", fetch: "builtin", unparsable: "builtin" } as Record<keyof Defaults, Layer>;
  let rules: Rule[] = [];
  const tests: PolicyTest[] = [];
  const overridden: { rule: Rule; by: string }[] = [];
  const files: Policy["files"] = [];

  for (const { layer, file, text } of layers) {
    files.push({ layer, file, loaded: text !== null });
    if (text === null) continue;
    const raw = parseFile(text, file);
    for (const [k, v] of Object.entries(raw.defaults ?? {})) {
      if (!(k in defaults)) throw new PolicyError(`${file}: unknown default "${k}" (use ${Object.keys(defaults).join(", ")})`);
      defaults[k as keyof Defaults] = checkAction(v, `${file}: defaults.${k}`);
      defaultsFrom[k as keyof Defaults] = layer;
    }
    for (const id of raw.disable ?? []) {
      const victims = rules.filter((r) => r.id === id);
      if (!victims.length) throw new PolicyError(`${file}: disable lists "${id}", but no earlier rule has that id`);
      for (const v of victims) {
        if (layer === "project" && (v.layer === "user" || v.locked)) {
          throw new PolicyError(`${file}: a project policy cannot disable ${v.locked ? "locked" : "user"} rule "${id}"`);
        }
        overridden.push({ rule: v, by: `disabled in ${file}` });
      }
      rules = rules.filter((r) => r.id !== id);
    }
    const seen = new Set<string>();
    (raw.rules ?? []).forEach((spec, i) => {
      const rule = compileRule(spec, layer, file, root, i);
      if (seen.has(rule.id)) throw new PolicyError(`${file}: duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      const prev = rules.find((r) => r.id === rule.id);
      if (prev) {
        if (layer === "project" && (prev.layer === "user" || prev.locked)) {
          throw new PolicyError(`${file}: rule "${rule.id}" would replace a ${prev.locked ? "locked" : "user"} rule; pick another id`);
        }
        overridden.push({ rule: prev, by: `replaced by ${file}` });
        rules = rules.filter((r) => r !== prev);
      }
      rules.push(rule);
    });
    (raw.tests ?? []).forEach((t, i) => tests.push(compileTest(t, layer, file, i)));
  }

  // The OS temp directory varies by machine, so it is added here rather than in the TOML.
  const temp = rules.find((r) => r.id === "write-temp" && r.layer === "builtin");
  // It gets the specificity of "/tmp/**" so a long temp path does not outrank other rules.
  if (temp?.paths) temp.paths.push({ ...compilePathPattern(toPosix(os.tmpdir()) + "/**", root), specificity: 5 });

  return { root, rules, defaults, defaultsFrom, tests, files, overridden };
}
