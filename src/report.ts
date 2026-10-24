/**
 * Turn a list of decisions (from the audit log or from `replay`) into a
 * one-screen report: counts by action, the riskiest blocked attempts first,
 * and per-agent / per-project breakdowns. Everything here is display only; the
 * inputs are already secret-redacted when they come from the audit log, and
 * paths are reduced to a redacted shape before anything is shown.
 */
import { homeDir, toPosix } from "./paths.js";
import { redact } from "./secrets.js";

/** The minimum a record needs to be reported on. AuditEntry is a superset. */
export interface EvalRecord {
  ts?: string;
  source: string;
  project: string;
  tool: string;
  agentTool?: string;
  input: string;
  action: string;
  rule: string;
  layer: string;
  subject?: string;
}

export type ActionCounts = { allow: number; ask: number; deny: number };

export interface RiskGroup {
  /** Stable category slug, e.g. "force-push". */
  category: string;
  /** Human label, e.g. "force pushes". */
  label: string;
  action: "ask" | "deny";
  rule: string;
  count: number;
  risk: number;
  /** Up to a few redacted example inputs, most recent last. */
  examples: string[];
}

export interface Report {
  since?: string;
  total: number;
  byAction: ActionCounts;
  byTool: Record<string, ActionCounts>;
  risky: RiskGroup[];
  byAgent: ({ source: string } & ActionCounts)[];
  byProject: ({ project: string } & ActionCounts)[];
  /** Short "N <label> blocked" lines for the card, riskiest first. */
  headline: { label: string; count: number; action: "ask" | "deny" }[];
  /** bash calls that were allowed; the card's "N commands allowed". */
  commandsAllowed: number;
}

/**
 * Category and risk weight for the built-in rules. Unknown rule ids fall back
 * to a category named after the rule and a risk from the action alone, so a
 * user's own deny rules (e.g. curl to an unknown host) still rank sensibly.
 */
const CATEGORIES: Record<string, { category: string; label: string; risk: number }> = {
  "rm-root-or-home": { category: "destructive-delete", label: "destructive deletes", risk: 98 },
  "disk-tools": { category: "destructive-delete", label: "disk wipes", risk: 97 },
  "git-force-push": { category: "force-push", label: "force pushes", risk: 92 },
  "protect-fence": { category: "self-protect", label: "policy or hook edits", risk: 90 },
  "protect-fence-cli": { category: "self-protect", label: "policy disable attempts", risk: 90 },
  "secret-files": { category: "secret-read", label: "secret file reads", risk: 85 },
  "secret-in-input": { category: "secret-in-input", label: "credentials in a command", risk: 82 },
  "publish-or-delete": { category: "publish", label: "publish or delete", risk: 78 },
  "git-discard-work": { category: "history-rewrite", label: "history or work discards", risk: 72 },
  "pipe-to-shell": { category: "pipe-to-shell", label: "pipe-to-shell", risk: 68 },
  "pipe-to-interpreter": { category: "pipe-to-shell", label: "pipe-to-interpreter", risk: 68 },
  "write-outside-project": { category: "write-outside", label: "writes outside the project", risk: 64 },
  "secret-files-write": { category: "secret-write", label: "secret file writes", risk: 60 },
  "sudo": { category: "privilege", label: "privileged commands", risk: 56 },
  "git-rewrite-config": { category: "git-config", label: "git config changes", risk: 52 },
  "package-install": { category: "package-install", label: "package installs", risk: 40 },
  "dynamic-command": { category: "dynamic", label: "dynamic commands", risk: 36 },
};

export function categorize(rec: Pick<EvalRecord, "rule" | "action" | "tool">): { category: string; label: string; risk: number } {
  const known = CATEGORIES[rec.rule];
  if (known) return known;
  const base = rec.action === "deny" ? 50 : 20;
  const fetchBump = rec.tool === "fetch" ? 10 : 0;
  return { category: rec.rule, label: rec.rule.replace(/[-_]/g, " "), risk: base + fetchBump };
}

const emptyCounts = (): ActionCounts => ({ allow: 0, ask: 0, deny: 0 });

function bump(c: ActionCounts, action: string): void {
  if (action === "allow" || action === "ask" || action === "deny") c[action]++;
}

/** Home directory collapsed to ~ and long absolute paths reduced to a trailing shape. */
export function redactPathShape(input: string, home = homeDir()): string {
  let s = toPosix(input);
  const h = toPosix(home);
  if (h && s.toLowerCase().startsWith(h.toLowerCase())) s = "~" + s.slice(h.length);
  // Keep only the last two segments of a deep absolute path so a report or card never leaks a tree.
  s = s.replace(/(^|[\s"'(=])(\/[^\s"')]+)/g, (_m, pre: string, p: string) => {
    const segs = p.split("/").filter(Boolean);
    return pre + (segs.length > 2 ? ".../" + segs.slice(-2).join("/") : p);
  });
  return s;
}

/** A short, redacted example for display: secrets gone, home collapsed, clipped. */
export function exampleText(rec: EvalRecord, home = homeDir()): string {
  const raw = rec.subject && rec.tool !== "bash" ? rec.subject : rec.input;
  const shaped = redactPathShape(redact(raw), home);
  const oneLine = shaped.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? oneLine.slice(0, 69) + "..." : oneLine;
}

export function buildReport(records: EvalRecord[], opts: { since?: string; home?: string } = {}): Report {
  const home = opts.home ?? homeDir();
  const byAction = emptyCounts();
  const byTool: Record<string, ActionCounts> = {};
  const agents = new Map<string, ActionCounts>();
  const projects = new Map<string, ActionCounts>();
  const groups = new Map<string, RiskGroup>();

  for (const r of records) {
    bump(byAction, r.action);
    (byTool[r.tool] ??= emptyCounts()) && bump(byTool[r.tool], r.action);
    bump((agents.get(r.source) ?? agents.set(r.source, emptyCounts()).get(r.source))!, r.action);
    bump((projects.get(r.project) ?? projects.set(r.project, emptyCounts()).get(r.project))!, r.action);
    if (r.action === "ask" || r.action === "deny") {
      const cat = categorize(r);
      const key = `${r.rule}\u0000${r.action}`;
      const g = groups.get(key) ?? { category: cat.category, label: cat.label, action: r.action, rule: r.rule, count: 0, risk: cat.risk, examples: [] };
      g.count++;
      if (g.examples.length < 3) g.examples.push(exampleText(r, home));
      groups.set(key, g);
    }
  }

  const sev = (a: string) => (a === "deny" ? 2 : 1);
  const risky = [...groups.values()].sort((a, b) => sev(b.action) - sev(a.action) || b.risk - a.risk || b.count - a.count);

  // The card headline merges ask + deny groups by category, denies first.
  const headlineMap = new Map<string, { label: string; count: number; action: "ask" | "deny"; risk: number }>();
  for (const g of risky) {
    const h = headlineMap.get(g.category);
    if (h) {
      h.count += g.count;
      if (g.action === "deny") h.action = "deny";
    } else {
      headlineMap.set(g.category, { label: g.label, count: g.count, action: g.action, risk: g.risk });
    }
  }
  const headline = [...headlineMap.values()]
    .sort((a, b) => sev(b.action) - sev(a.action) || b.risk - a.risk || b.count - a.count)
    .map(({ label, count, action }) => ({ label, count, action }));

  const sortCounts = <T extends ActionCounts>(a: T, b: T) => b.deny - a.deny || b.ask - a.ask || b.allow - a.allow;
  return {
    since: opts.since,
    total: records.length,
    byAction,
    byTool,
    risky,
    byAgent: [...agents.entries()].map(([source, c]) => ({ source, ...c })).sort(sortCounts),
    byProject: [...projects.entries()].map(([project, c]) => ({ project, ...c })).sort(sortCounts),
    headline,
    commandsAllowed: byTool.bash?.allow ?? 0,
  };
}

const TOOL_LABEL: Record<string, string> = { bash: "commands", read: "file reads", write: "file writes", fetch: "fetches" };

/** The human one-screen report. */
export function formatReport(r: Report, opts: { home?: string } = {}): string {
  const out: string[] = [];
  const win = r.since ? ` since ${r.since}` : "";
  out.push(`agent-fence report${win}`);
  if (!r.total) {
    out.push("");
    out.push("No decisions in the audit log for this window.");
    out.push("Entries appear once an agent hook, agent-fence exec or agent-fence-shell checks a call,");
    out.push("or run: agent-fence replay <session-log> to audit an existing transcript.");
    return out.join("\n") + "\n";
  }
  out.push(`${r.total} decisions:  ${r.byAction.allow} allowed  ${r.byAction.ask} asked  ${r.byAction.deny} denied`);
  out.push("");
  out.push("by tool");
  for (const tool of ["bash", "read", "write", "fetch"]) {
    const c = r.byTool[tool];
    if (!c) continue;
    out.push(`  ${(TOOL_LABEL[tool] ?? tool).padEnd(12)} ${c.allow} allowed  ${c.ask} asked  ${c.deny} denied`);
  }

  if (r.risky.length) {
    out.push("");
    out.push("riskiest blocked attempts first");
    for (const g of r.risky) {
      const verb = g.action === "deny" ? "denied" : "asked ";
      out.push(`  ${verb} x${String(g.count).padEnd(4)} ${g.label}  [${g.rule}]`);
      for (const ex of g.examples) out.push(`           ${ex}`);
    }
  } else {
    out.push("");
    out.push("No blocked or asked attempts in this window.");
  }

  if (r.byAgent.length > 1) {
    out.push("");
    out.push("by agent");
    for (const a of r.byAgent) out.push(`  ${a.source.padEnd(8)} ${a.allow} allowed  ${a.ask} asked  ${a.deny} denied`);
  }
  if (r.byProject.length > 1) {
    out.push("");
    out.push("by project");
    for (const p of r.byProject.slice(0, 10)) {
      out.push(`  ${redactPathShape(p.project, opts.home).padEnd(28)} ${p.allow} allowed  ${p.ask} asked  ${p.deny} denied`);
    }
  }
  out.push("");
  out.push("A shareable card: agent-fence report --card card.png     Why a rule fired: agent-fence explain <rule>");
  return out.join("\n") + "\n";
}
