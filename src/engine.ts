import { readdirSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { expandBraces, matchCommand } from "./match.js";
import { hasSubst, parseShell, programName, type SimpleCommand } from "./parse.js";
import { expandHome, homeDir, isInside, normalizePath, toPosix } from "./paths.js";
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
const WRITES_ALL_ARGS = new Set(["rm", "rmdir", "unlink", "shred", "touch", "mkdir", "truncate", "chmod", "chown", "chgrp", "tee", "mv"]);
/** Commands whose last non-option argument is a destination they write. */
const WRITES_LAST_ARG = new Set(["cp", "ln", "install", "rsync", "scp"]);
/** Commands whose first argument is not a path even though it does not start with "-". */
const FIRST_ARG_NOT_PATH = new Set(["chmod", "chown", "chgrp", "truncate"]);
/**
 * Commands that only look at names or metadata, never at file contents, so a
 * secret file named in their arguments is not read: `echo .env >> .gitignore`,
 * `ls -la .env`, `test -f .env`.
 */
const NO_CONTENT_READ = new Set([
  "echo", "printf", "ls", "test", "[", "[[", "stat", "basename", "dirname", "realpath", "readlink", "which", "type",
  "du", "mkdir", "touch", "tee", "rmdir", "rm", "unlink", "chmod", "chown", "chgrp", "true", "false", "cd", "pushd", "pwd", "exit",
]);
/** git subcommands that do not read file contents. */
const GIT_NO_CONTENT = new Set(["check-ignore", "ls-files", "status", "rm", "mv", "restore", "checkout", "switch", "branch", "tag", "init", "remote", "config"]);
/** Commands that delete what they are given when run with -r / -R / --recursive. */
const RECURSIVE_DELETE = new Set(["rm"]);

function looksLikePathArg(a: string): boolean {
  if (!a || a.length > 1024 || a.includes("\n") || hasSubst(a)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return false;
  return true;
}

/** The value of an option given as `-C dir`, `-Cdir`, `--directory dir` or `--directory=dir`. */
function optionValue(argv: string[], short: string[], long: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (short.includes(a) || long.includes(a)) return argv[i + 1];
    for (const l of long) if (a.startsWith(l + "=")) return a.slice(l.length + 1);
  }
  return undefined;
}

/** Index of the git subcommand, skipping global options such as -C dir and -c key=value. */
function gitSubcommand(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

interface Targets {
  reads: string[];
  writes: string[];
  /** Paths removed as a whole (rm -r, find -delete): checked against the project root and home too. */
  deletes: string[];
}

function bashTargets(cmd: SimpleCommand): Targets {
  const reads: string[] = [];
  const writes: string[] = [];
  const deletes: string[] = [];
  for (const r of cmd.redirects) {
    if (r.op === "<<<" || r.op === "<<" || r.op === "<<-" || hasSubst(r.target)) continue;
    if (r.op === "<" || r.op === "<&") reads.push(r.target);
    else if (r.op === "<>") {
      reads.push(r.target);
      writes.push(r.target);
    } else writes.push(r.target);
  }
  const clean = (l: string[]) => l.filter(looksLikePathArg);
  if (!cmd.argv.length) return { reads: clean(reads), writes: clean(writes), deletes };
  const argv = cmd.argv;
  const prog = programName(argv[0]);
  const args: string[] = [];
  let endOfOpts = false;
  let recursive = false;
  for (const a of argv.slice(1)) {
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq > 0) reads.push(a.slice(eq + 1));
      if (a === "--recursive" || /^-[A-Za-z]*[rR]/.test(a)) recursive = true;
      continue;
    }
    args.push(a);
  }
  const contentRead = !NO_CONTENT_READ.has(prog) && !(prog === "git" && GIT_NO_CONTENT.has(gitSubcommand(argv) ?? ""));
  const targetDir = optionValue(argv, ["-t"], ["--target-directory"]);
  if (contentRead) {
    // The destination of cp, ln, install, rsync and scp is written, not read.
    const sources = WRITES_LAST_ARG.has(prog) && targetDir === undefined && args.length >= 2 ? args.slice(0, -1) : args;
    for (const a of sources) reads.push(a);
    // curl -d @file, curl -F name=@file, gh api -F key=@file: the part after @ (or <) is a file that is read.
    for (const a of [...reads]) {
      const at = /^@(.+)$/.exec(a) ?? /^[^=\s]+=[@<](.+)$/.exec(a);
      if (at && at[1] !== "-") reads.push(at[1]);
    }
  }

  if (WRITES_ALL_ARGS.has(prog)) writes.push(...(FIRST_ARG_NOT_PATH.has(prog) ? args.slice(1) : args));
  else if (WRITES_LAST_ARG.has(prog) && targetDir !== undefined) writes.push(targetDir);
  else if (WRITES_LAST_ARG.has(prog) && args.length >= 2) writes.push(args[args.length - 1]);
  else if ((prog === "sed" || prog === "perl") && argv.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    writes.push(...args.slice(prog === "sed" && !argv.some((a) => a === "-e" || a === "-f") ? 1 : 0));
  }
  if (prog === "mv" && targetDir !== undefined) writes.push(targetDir);
  if (RECURSIVE_DELETE.has(prog) && recursive) deletes.push(...args);
  if (prog === "find") {
    // find's starting points come before the first expression word.
    const starts: string[] = [];
    for (const a of argv.slice(1)) {
      if (/^[-(!]/.test(a)) break;
      starts.push(a);
    }
    const runs = argv.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    const runsWriter = runs > 0 && argv[runs + 1] !== undefined && (WRITES_ALL_ARGS.has(programName(argv[runs + 1])) || WRITES_LAST_ARG.has(programName(argv[runs + 1])));
    if (argv.includes("-delete") || runsWriter) {
      // Deleting matches under a starting point, not the starting point itself, so only a write.
      writes.push(...(starts.length ? starts : ["."]));
    }
  }
  if (prog === "tar" || prog === "bsdtar" || prog === "gtar") {
    const mode = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
    const extract = argv.some((a) => a === "--extract" || a === "--get" || /^-[A-Za-z]*x/.test(a)) || (/^[A-Za-z]+$/.test(mode) && mode.includes("x") && argv[1] === mode);
    if (extract) {
      writes.push(optionValue(argv, ["-C"], ["--directory"]) ?? ".");
      // -P keeps absolute paths and .. in member names, so the archive can write anywhere.
      if (argv.some((a) => a === "--absolute-names" || /^-[A-Za-z]*P/.test(a))) writes.push("/");
    }
  }
  if (prog === "unzip") {
    const d = optionValue(argv, ["-d"], []);
    if (d !== undefined) writes.push(d);
  }
  return { reads: clean(reads), writes: clean(writes), deletes: clean(deletes) };
}

const GLOB_CHARS = /[*?[]/;
const MAX_GLOB_RESULTS = 200;

/**
 * Expand an argument the way the shell will before the command runs: {a,b}
 * alternatives, then *, ? and [...] against the file system. Returns the
 * expansions only (empty when there is nothing to expand or nothing matches).
 */
export function expandArg(word: string, cwd: string): string[] {
  const alts = /\{[^{}]*,[^{}]*\}/.test(word) ? expandBraces(word) : [word];
  const out: string[] = alts.length > 1 ? [...alts] : [];
  for (const alt of alts) {
    if (!GLOB_CHARS.test(alt)) continue;
    const p = toPosix(expandHome(alt));
    const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
    const segs = p.split("/");
    let bases = [absolute ? (segs[0] === "" ? "/" : segs[0] + "/") : cwd];
    for (const seg of absolute ? segs.slice(1) : segs) {
      if (!seg) continue;
      const next: string[] = [];
      if (!GLOB_CHARS.test(seg)) {
        for (const b of bases) next.push(path.posix.join(toPosix(b), seg));
      } else {
        // bash without globstar treats ** like *
        const isMatch = picomatch(seg.replace(/\*\*+/g, "*"), { dot: false });
        for (const b of bases) {
          let names: string[] = [];
          try {
            names = readdirSync(b);
          } catch {
            continue;
          }
          for (const n of names) if (isMatch(n)) next.push(path.posix.join(toPosix(b), n));
          if (next.length > MAX_GLOB_RESULTS) break;
        }
      }
      bases = next.slice(0, MAX_GLOB_RESULTS);
      if (!bases.length) break;
    }
    out.push(...bases);
  }
  return out;
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

/**
 * Deleting the filesystem root, the home directory, the project itself or one
 * of its parents (cd .. && rm -rf proj) falls under rm-root-or-home; deleting
 * the project's .git directory under git-discard-work. Both are looked up in the
 * policy, so a user who changes or disables them is respected.
 */
function checkDelete(policy: Policy, abs: string): Decision | undefined {
  const home = normalizePath(homeDir(), "/");
  const byId = (id: string) => policy.rules.find((r) => r.id === id && r.tools.includes("bash"));
  if (abs === "/" || /^[A-Za-z]:\/?$/.test(abs) || isInside(home, abs) || isInside(policy.root, abs)) {
    const r = byId("rm-root-or-home");
    if (r) return { action: r.action, reason: r.reason, rule: r.id, layer: r.layer, subject: abs, pattern: "recursive delete of a protected directory" };
  }
  if (abs.toLowerCase() === (policy.root.replace(/\/$/, "") + "/.git").toLowerCase()) {
    const r = byId("git-discard-work");
    if (r) return { action: r.action, reason: r.reason, rule: r.id, layer: r.layer, subject: abs, pattern: "delete of the .git directory" };
  }
  return undefined;
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
    const { reads, writes, deletes } = bashTargets(cmd);
    for (const [tool, list] of [["read", reads], ["write", writes]] as const) {
      for (const target of list) {
        for (const t of [target, ...expandArg(target, dir)]) {
          const d = checkPath(policy, tool, t, dir);
          // Paths inside commands can only make a decision stricter.
          if (d.rule !== "default" && d.action !== "allow") decisions.push({ ...d, subject: `${subject} (${tool} ${d.subject})` });
        }
      }
    }
    for (const target of deletes) {
      const d = checkDelete(policy, normalizePath(target, dir));
      if (d) decisions.push({ ...d, subject: `${subject} (delete ${d.subject})` });
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

/** How a person changes the outcome of a decision, in one sentence. */
export function howToChange(d: Decision): string {
  if (d.rule === "unparsable") return `If it is intended, the user can run it, or set unparsable = "allow" under [defaults] in .agent-fence.toml.`;
  if (d.rule === "default" || d.rule === "policy-error") return "";
  return `If it is intended, the user can allow it in .agent-fence.toml (run: agent-fence explain ${d.rule}).`;
}

/** One-line text shown to the agent (and to the user, who sees it in the agent's transcript). */
export function formatReason(d: Decision, instruction = ""): string {
  const what = d.action === "deny" ? "blocked" : d.action === "ask" ? "needs the user's approval" : "allowed";
  const where = d.subject ? ` [${d.subject.length > 200 ? d.subject.slice(0, 197) + "..." : d.subject}]` : "";
  const reason = d.reason.trim().replace(/([^.!?])$/, "$1.");
  const change = d.action === "allow" ? "" : howToChange(d);
  return `agent-fence: ${what} by rule "${d.rule}"${where}. ${reason}${instruction ? " " + instruction : ""}${change ? " " + change : ""}`;
}
