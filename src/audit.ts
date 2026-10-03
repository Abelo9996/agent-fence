import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Decision, Request } from "./engine.js";
import { stateDir } from "./paths.js";
import { redact } from "./secrets.js";

export interface AuditEntry {
  ts: string;
  /** Which integration made the call: check, claude, codex, exec, shell. */
  source: string;
  project: string;
  cwd: string;
  tool: string;
  /** The agent's own tool name when it differs (Bash, Edit, apply_patch, ...). */
  agentTool?: string;
  /** Command, path or URL, with anything secret-looking redacted and long input truncated. */
  input: string;
  action: string;
  rule: string;
  layer: string;
  reason: string;
  subject?: string;
  session?: string;
}

export function auditLogPath(): string {
  return process.env.AGENT_FENCE_LOG || path.join(stateDir(), "audit.jsonl");
}

const MAX_INPUT = 2000;

function clip(s: string): string {
  return s.length > MAX_INPUT ? s.slice(0, MAX_INPUT) + `... [${s.length - MAX_INPUT} more chars]` : s;
}

export function describeInput(req: Request): string {
  if (req.tool === "bash") return req.command ?? "";
  if (req.tool === "fetch") return req.url ?? "";
  return req.path ?? "";
}

/** Append one decision. Never throws: a broken log must not break the agent. */
export function appendAudit(e: {
  source: string;
  project: string;
  cwd: string;
  req: Request;
  decision: Decision;
  agentTool?: string;
  session?: string;
}): void {
  if (process.env.AGENT_FENCE_NO_LOG === "1") return;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    source: e.source,
    project: e.project,
    cwd: e.cwd,
    tool: e.req.tool,
    agentTool: e.agentTool,
    input: clip(redact(describeInput(e.req))),
    action: e.decision.action,
    rule: e.decision.rule,
    layer: e.decision.layer,
    reason: e.decision.reason,
    subject: e.decision.subject ? clip(redact(e.decision.subject)) : undefined,
    session: e.session,
  };
  try {
    const file = auditLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // ignore
  }
}

export function readAudit(file = auditLogPath()): AuditEntry[] {
  if (!existsSync(file)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Parse "30m", "2h", "7d" or an ISO date into a Date. */
export function parseSince(s: string, now = Date.now()): Date {
  const m = /^(\d+)\s*([smhdw])$/.exec(s.trim());
  if (m) {
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as "s"]!;
    return new Date(now - Number(m[1]) * unit);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read --since "${s}"; use 30m, 2h, 7d or a date`);
  return d;
}
