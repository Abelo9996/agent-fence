import path from "node:path";
import { commandCandidates, pathCandidates, pick, urlCandidates, type Candidate } from "./engine.js";
import { expandBraces } from "./match.js";
import type { SimpleCommand } from "./parse.js";
import { isInside, normalizePath, toPosix } from "./paths.js";
import { severity, type Action, type Layer, type Policy, type Rule, type Tool } from "./policy.js";
import type { TestOutcome } from "./policy-tests.js";

/** A rule that never decides the smallest input its own matcher accepts. */
export interface ShadowedRule {
  id: string;
  layer: Layer;
  file: string;
  action: Action;
  /** The input that was tried, e.g. `bash "git push"`. */
  example: string;
  tool: Tool;
  subject: string;
  winner: { id: string; layer: Layer; action: Action };
  why: string;
}

export interface LintReport {
  /** Rules from the user and project files. */
  checked: string[];
  /** Rules whose matcher cannot be turned into an example (command_regex, secrets). */
  notChecked: string[];
  shadowed: ShadowedRule[];
}

interface Example {
  tool: Tool;
  subject: string;
  label: string;
  candidates: () => Candidate[];
}

/** Replace wildcards with a plain word so the pattern matches its own example. */
function fill(glob: string, star = "x"): string | null {
  const alt = expandBraces(glob)[0];
  if (/(^|[^\\])\[/.test(alt)) return null;
  let out = "";
  let escaped = false;
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i];
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === "*") {
      while (alt[i + 1] === "*") i++;
      out += star;
    } else if (ch === "?") out += "x";
    else out += ch;
  }
  return out;
}

function command(argv: string[], pipedInput: boolean, dynamic = false): SimpleCommand {
  return { argv, redirects: [], env: [], pipedInput, via: [], dynamic };
}

function examples(policy: Policy, r: Rule): Example[] {
  const out: Example[] = [];
  for (const p of r.commands ?? []) {
    const words = p.source.trim().split(/\s+/).map((w) => fill(w));
    if (words.some((w) => w === null)) continue;
    const cmd = command(words as string[], r.pipedInput === true);
    const subject = (r.pipedInput ? "... | " : "") + cmd.argv.join(" ");
    out.push({ tool: "bash", subject, label: `bash ${JSON.stringify(subject)}`, candidates: () => commandCandidates(policy, cmd) });
  }
  if (r.dynamic) {
    out.push({ tool: "bash", subject: "$prog args", label: 'bash "$prog args"', candidates: () => commandCandidates(policy, command([], false, true)) });
  }
  const pathTools = r.tools.filter((t): t is "read" | "write" => t === "read" || t === "write");
  for (const p of r.paths ?? []) {
    let sample = fill(p.source);
    if (sample === null) continue;
    if (sample.startsWith("x/") && p.source.startsWith("**")) sample = sample.slice(2);
    const abs = normalizePath(sample, policy.root);
    const shown = isInside(abs, policy.root) ? toPosix(path.relative(policy.root, abs)) || "." : abs;
    for (const tool of pathTools) {
      out.push({ tool, subject: shown, label: `${tool} ${JSON.stringify(shown)}`, candidates: () => pathCandidates(policy, tool, abs) });
    }
  }
  if (r.outsideProject) {
    const abs = normalizePath(path.join(path.parse(policy.root).root, "agent-fence-lint-outside", "x"), policy.root);
    for (const tool of pathTools) {
      out.push({ tool, subject: abs, label: `${tool} ${JSON.stringify(abs)}`, candidates: () => pathCandidates(policy, tool, abs) });
    }
  }
  for (const u of r.urls ?? []) {
    const sample = fill(u.source);
    if (sample === null) continue;
    out.push({ tool: "fetch", subject: sample, label: `fetch ${JSON.stringify(sample)}`, candidates: () => urlCandidates(policy, sample) });
  }
  return out;
}

function layerName(l: Layer): string {
  return l === "builtin" ? "built-in" : l;
}

function explainLoss(own: Candidate, win: Candidate, cands: Candidate[]): string {
  if (own.rule.layer === "project") {
    const floor = cands.filter((c) => c.rule.layer === "user" || c.rule.locked).sort((a, b) => severity(b.rule.action) - severity(a.rule.action))[0];
    if (floor && severity(floor.rule.action) > severity(own.rule.action)) {
      return `a project rule cannot loosen ${floor.rule.locked ? "locked" : "user"} rule "${floor.rule.id}" (${floor.rule.action})`;
    }
  }
  if (win.score > own.score) return `"${win.rule.id}" is more specific (score ${win.score} vs ${own.score}); raise this rule's priority or disable "${win.rule.id}"`;
  if (severity(win.rule.action) > severity(own.rule.action)) {
    return `same specificity, and ${win.rule.action} beats ${own.rule.action} on a tie; raise this rule's priority or disable "${win.rule.id}"`;
  }
  return `"${win.rule.id}" matches the same inputs and comes first`;
}

/**
 * Find user and project rules that can never decide anything. For each pattern of a
 * rule, the smallest input it matches (wildcards filled with a plain word) is decided
 * the way the engine would; if another rule wins every one of those examples, the
 * rule is reported with the winner and the reason. command_regex and secrets rules
 * cannot be turned into an example and are listed as not checked.
 */
export function lintPolicy(policy: Policy, opts: { layers?: Layer[] } = {}): LintReport {
  const layers = opts.layers ?? ["user", "project"];
  const report: LintReport = { checked: [], notChecked: [], shadowed: [] };
  for (const r of policy.rules) {
    if (!layers.includes(r.layer)) continue;
    const exs = examples(policy, r);
    if (!exs.length) {
      report.notChecked.push(r.id);
      continue;
    }
    report.checked.push(r.id);
    let firstLoss: ShadowedRule | undefined;
    let reachable = false;
    let conclusive = false;
    for (const ex of exs) {
      const cands = ex.candidates();
      const own = cands.find((c) => c.rule === r);
      // The pattern did not match its own example (an unusual glob): no conclusion.
      if (!own) continue;
      conclusive = true;
      const win = pick(cands);
      if (!win || win.rule === r) {
        reachable = true;
        break;
      }
      firstLoss ??= {
        id: r.id,
        layer: r.layer,
        file: r.file,
        action: r.action,
        example: ex.label,
        tool: ex.tool,
        subject: ex.subject,
        winner: { id: win.rule.id, layer: win.rule.layer, action: win.rule.action },
        why: explainLoss(own, win, cands),
      };
    }
    if (conclusive && !reachable && firstLoss) report.shadowed.push(firstLoss);
  }
  return report;
}

/** User and project rules that no [[tests]] case is decided by or names. */
export function untestedRules(policy: Policy, outcomes: TestOutcome[]): string[] {
  const hit = new Set<string>();
  for (const o of outcomes) {
    if (o.decision) hit.add(o.decision.rule);
    if (o.test.rule) hit.add(o.test.rule);
  }
  return policy.rules.filter((r) => r.layer !== "builtin" && !hit.has(r.id)).map((r) => r.id);
}

export function describeShadowed(s: ShadowedRule): string {
  return `rule "${s.id}" (${layerName(s.layer)}, ${s.action}) never decides: for ${s.example} rule "${s.winner.id}" (${layerName(s.winner.layer)}, ${s.winner.action}) wins: ${s.why}`;
}
