import path from "node:path";
import { matchCommand } from "./match.js";
import { parseShell, programName, SUBST, type SimpleCommand } from "./parse.js";
import { isInside, normalizePath } from "./paths.js";
import { severity, type Action, type Layer, type Policy, type Rule, type Tool } from "./policy.js";
import { findSecrets } from "./secrets.js";

export interface Request {
  tool: Tool;
  /** Shell command text, for tool "bash". */
  command?: string;
  /** File path, for read and write. */
  path?: string;
  /** Text being written, for write (checked for secrets). */
  content?: string;
  url?: string;
  /** Directory relative paths and the command are resolved against. Defaults to the project root. */
  cwd?: string;
}

export interface Decision {
  action: Action;
  reason: string;
  /** Rule id, or "default" / "unparsable" when no rule matched. */
  rule: string;
  layer: Layer;
  /** The part of the input that triggered the decision: one simple command, or a path. */
  subject?: string;
  /** The pattern within the rule that matched. */
  pattern?: string;
}

interface Candidate {
  rule: Rule;
  score: number;
  pattern?: string;
}

const LAYER_RANK: Record<Layer, number> = { builtin: 0, user: 1, project: 2 };

/**
 * Choose the winning candidate: highest specificity (+ priority), then the
 * strictest action, then the later layer (project over user over builtin).
 * A project rule can never loosen a user rule: if a user rule matched with ask
 * or deny, project candidates with a weaker action are dropped first.
 */
export function pick(cands: Candidate[]): Candidate | undefined {
  const userFloor = Math.max(-1, ...cands.filter((c) => c.rule.layer === "user").map((c) => severity(c.rule.action)));
  const lockedFloor = Math.max(-1, ...cands.filter((c) => c.rule.locked).map((c) => severity(c.rule.action)));
  const pool = cands.filter((c) => c.rule.layer !== "project" || severity(c.rule.action) >= Math.max(userFloor, lockedFloor));
  return pool.sort(
    (a, b) =>
      b.score - a.score ||
      severity(b.rule.action) - severity(a.rule.action) ||
      LAYER_RANK[b.rule.layer] - LAYER_RANK[a.rule.layer],
  )[0];
}

function fromCandidate(c: Candidate, subject?: string): Decision {
  return { action: c.rule.action, reason: c.rule.reason, rule: c.rule.id, layer: c.rule.layer, subject, pattern: c.pattern };
}

function fallback(policy: Policy, tool: Tool, subject?: string): Decision {
  return {
    action: policy.defaults[tool],
    reason: `No rule matched; the default for ${tool} is ${policy.defaults[tool]}.`,
    rule: "default",
    layer: policy.defaultsFrom[tool],
    subject,
  };
}

function strictest(ds: Decision[]): Decision | undefined {
  let best: Decision | undefined;
  for (const d of ds) if (!best || severity(d.action) > severity(best.action)) best = d;
  return best;
}

function rulesFor(policy: Policy, tool: Tool): Rule[] {
  return policy.rules.filter((r) => r.tools.includes(tool));
}

/** Candidates from path-based rules (path globs and outside_project). */
function pathCandidates(policy: Policy, tool: "read" | "write", absPath: string): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rulesFor(policy, tool)) {
    if (r.paths) {
      const hits = r.paths.filter((p) => p.test(absPath));
      if (hits.length) {
        const best = hits.reduce((a, b) => (b.specificity > a.specificity ? b : a));
        out.push({ rule: r, score: best.specificity + r.priority, pattern: best.source });
      }
    } else if (r.outsideProject && !isInside(absPath, policy.root)) {
      out.push({ rule: r, score: r.priority, pattern: "outside_project" });
    }
  }
  return out;
}

function secretCandidates(policy: Policy, tool: Tool, text: string): Candidate[] {
  const found = findSecrets(text);
  if (!found.length) return [];
  return rulesFor(policy, tool)
    .filter((r) => r.secrets)
    .map((r) => ({ rule: r, score: r.priority, pattern: found.join(", ") }));
}

export function checkPath(policy: Policy, tool: "read" | "write", p: string, cwd: string): Decision {
  const abs = normalizePath(p, cwd);
  const win = pick(pathCandidates(policy, tool, abs));
  return win ? fromCandidate(win, abs) : fallback(policy, tool, abs);
}

/** Commands whose non-option arguments are all files they modify. */
const WRITES_ALL_ARGS = new Set(["rm", "rmdir", "unlink", "shred", "touch", "mkdir", "truncate", "chmod", "chown", "chgrp", "tee"]);
/** Commands whose last non-option argument is a destination they write. */
const WRITES_LAST_ARG = new Set(["cp", "mv", "ln", "install", "rsync", "scp"]);
/** Commands whose first argument is not a path even though it does not start with "-". */
const FIRST_ARG_NOT_PATH = new Set(["chmod", "chown", "chgrp", "truncate"]);

function looksLikePathArg(a: string): boolean {
  if (!a || a.length > 1024 || a.includes("\n") || a.includes(SUBST)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return false;
  return true;
}

function bashTargets(cmd: SimpleCommand): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const r of cmd.redirects) {
    if (r.op === "<<<" || r.target.includes(SUBST)) continue;
    if (r.op === "<" || r.op === "<&") reads.push(r.target);
    else if (r.op === "<>") {
      reads.push(r.target);
      writes.push(r.target);
    } else writes.push(r.target);
  }
  if (!cmd.argv.length) return { reads, writes };
  const prog = programName(cmd.argv[0]);
  const args: string[] = [];
  let endOfOpts = false;
  for (const a of cmd.argv.slice(1)) {
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq > 0) reads.push(a.slice(eq + 1));
      continue;
    }
    args.push(a);
  }
  for (const a of args) reads.push(a);
  if (WRITES_ALL_ARGS.has(prog)) writes.push(...(FIRST_ARG_NOT_PATH.has(prog) ? args.slice(1) : args));
  else if (WRITES_LAST_ARG.has(prog) && args.length >= 2) writes.push(args[args.length - 1]);
  else if ((prog === "sed" || prog === "perl") && cmd.argv.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    writes.push(...args.slice(prog === "sed" && !cmd.argv.some((a) => a === "-e" || a === "-f") ? 1 : 0));
  }
  return { reads: reads.filter(looksLikePathArg), writes: writes.filter(looksLikePathArg) };
}

function commandCandidates(policy: Policy, cmd: SimpleCommand): Candidate[] {
  const out: Candidate[] = [];
  const text = cmd.argv.join(" ");
  for (const r of rulesFor(policy, "bash")) {
    if (r.pipedInput && !cmd.pipedInput) continue;
    if (r.commands) {
      const hits = r.commands.filter((p) => matchCommand(p, cmd));
      if (hits.length) {
        const best = hits.reduce((a, b) => (b.specificity > a.specificity ? b : a));
        out.push({ rule: r, score: best.specificity + r.priority, pattern: best.source });
      }
    } else if (r.commandRegex && cmd.argv.length && r.commandRegex.re.test(text)) {
      out.push({ rule: r, score: r.commandRegex.specificity + r.priority, pattern: r.commandRegex.re.source });
    } else if (r.dynamic && cmd.dynamic) {
      out.push({ rule: r, score: r.priority, pattern: "dynamic" });
    }
  }
  return out;
}

/** Decide one shell command string. */
export function checkBash(policy: Policy, command: string, cwd: string): Decision {
  const parsed = parseShell(command);
  const decisions: Decision[] = [];
  if (parsed.error) {
    decisions.push({
      action: policy.defaults.unparsable,
      reason: `agent-fence could not parse this command (${parsed.error}), so it cannot tell what it would run.`,
      rule: "unparsable",
      layer: policy.defaultsFrom.unparsable,
      subject: command,
    });
  }
  const secrets = pick(secretCandidates(policy, "bash", command));
  if (secrets) decisions.push(fromCandidate(secrets, "(command text)"));

  let dir = cwd;
  for (const cmd of parsed.commands) {
    const subject = cmd.argv.join(" ") || cmd.redirects.map((r) => r.op + r.target).join(" ");
    const win = pick(commandCandidates(policy, cmd));
    decisions.push(win ? fromCandidate(win, subject) : fallback(policy, "bash", subject));
    const { reads, writes } = bashTargets(cmd);
    for (const [tool, list] of [["read", reads], ["write", writes]] as const) {
      for (const target of list) {
        const d = checkPath(policy, tool, target, dir);
        // Paths inside commands can only make a decision stricter.
        if (d.rule !== "default" && d.action !== "allow") decisions.push({ ...d, subject: `${subject} (${tool} ${d.subject})` });
      }
    }
    // Track `cd` so later relative paths resolve the way the shell would.
    if (cmd.via.length === 0 && cmd.argv.length && programName(cmd.argv[0]) === "cd") {
      const target = cmd.argv.find((a, i) => i > 0 && !a.startsWith("-"));
      dir = target ? normalizePath(target, dir) : dir;
    }
  }
  if (!parsed.commands.length && !decisions.length) return fallback(policy, "bash", command);
  return strictest(decisions)!;
}

export function evaluate(policy: Policy, req: Request): Decision {
  const cwd = req.cwd ? path.resolve(req.cwd) : policy.root;
  switch (req.tool) {
    case "bash":
      return checkBash(policy, req.command ?? "", cwd);
    case "read":
    case "write": {
      if (!req.path) throw new Error(`a ${req.tool} check needs a path`);
      const d = checkPath(policy, req.tool, req.path, cwd);
      if (req.tool === "write" && req.content) {
        const s = pick(secretCandidates(policy, "write", req.content));
        if (s && severity(s.rule.action) > severity(d.action)) return fromCandidate(s, "(file content)");
      }
      return d;
    }
    case "fetch": {
      const url = req.url ?? "";
      const cands: Candidate[] = [];
      for (const r of rulesFor(policy, "fetch")) {
        const hits = (r.urls ?? []).filter((u) => u.re.test(url));
        if (hits.length) {
          const best = hits.reduce((a, b) => (b.specificity > a.specificity ? b : a));
          cands.push({ rule: r, score: best.specificity + r.priority, pattern: best.source });
        }
      }
      const win = pick(cands);
      return win ? fromCandidate(win, url) : fallback(policy, "fetch", url);
    }
  }
}

/** One-line text shown to the agent. */
export function formatReason(d: Decision): string {
  const what = d.action === "deny" ? "blocked" : d.action === "ask" ? "needs the user's approval" : "allowed";
  const where = d.subject ? ` [${d.subject.length > 200 ? d.subject.slice(0, 197) + "..." : d.subject}]` : "";
  return `agent-fence: ${what} by rule "${d.rule}"${where}. ${d.reason}`;
}
