/**
 * Retroactive audit: run the policy over an existing Claude Code or Codex
 * session transcript and report what would have been blocked or asked, with no
 * hook installed. Both transcript formats are plain JSON lines.
 *
 * Claude Code: ~/.claude/projects/<slug>/<session>.jsonl, one record per line.
 *   Assistant turns carry message.content[] entries of type "tool_use" with a
 *   name (Bash, Read, Edit, ...) and an input object; the record also carries
 *   the cwd at the time.
 * Codex: ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl. A session_meta line
 *   gives the starting cwd, turn_context lines change it, and response_item
 *   lines carry function_call (exec_command, shell) and custom_tool_call
 *   (apply_patch) items.
 */
import { readFileSync } from "node:fs";
import { requestsFor, type HookPayload } from "./adapters.js";
import { describeInput } from "./audit.js";
import { evaluate, type Decision, type Request } from "./engine.js";
import { findProjectRoot } from "./paths.js";
import { loadPolicy, type Policy } from "./policy.js";
import type { EvalRecord } from "./report.js";

export type Source = "claude" | "codex";

export interface ReplayCall {
  source: Source;
  agentTool: string;
  req: Request;
}

export interface ReplayResult extends ReplayCall {
  decision: Decision;
  /** Whether a naive command-grep guard would also have flagged this. */
  naiveCaught: boolean;
}

export interface Replay {
  source: Source;
  calls: number;
  results: ReplayResult[];
}

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn or non-JSON line
    }
  }
  return out;
}

/** Guess the transcript format from its first usable line. */
export function detectSource(lines: Record<string, unknown>[]): Source | null {
  for (const o of lines) {
    const t = o.type;
    if (t === "session_meta" || t === "response_item" || t === "turn_context") return "codex";
    if (t === "assistant" || t === "user" || t === "summary") return "claude";
    if (o.payload && typeof o.payload === "object") return "codex";
    if (o.message && typeof o.message === "object") return "claude";
  }
  return null;
}

function claudeCalls(lines: Record<string, unknown>[]): ReplayCall[] {
  const calls: ReplayCall[] = [];
  for (const o of lines) {
    if (o.type !== "assistant") continue;
    const msg = o.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    const cwd = typeof o.cwd === "string" ? o.cwd : undefined;
    for (const c of content as Record<string, unknown>[]) {
      if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
      const payload: HookPayload = { tool_name: c.name, tool_input: (c.input as Record<string, unknown>) ?? {}, cwd };
      for (const req of requestsFor(payload)) calls.push({ source: "claude", agentTool: c.name, req });
    }
  }
  return calls;
}

/** Map one Codex response_item to the requests it would run, given the current cwd. */
function codexItem(p: Record<string, unknown>, cwd: string | undefined): ReplayCall[] {
  const name = typeof p.name === "string" ? p.name : "";
  if (p.type === "function_call" && name === "exec_command") {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(p.arguments ?? "{}"));
    } catch {
      return [];
    }
    const cmd = typeof args.cmd === "string" ? args.cmd : Array.isArray(args.cmd) ? args.cmd.map(String).join(" ") : undefined;
    if (cmd === undefined) return [];
    const workdir = typeof args.workdir === "string" ? args.workdir : cwd;
    return [{ source: "codex", agentTool: "exec_command", req: { tool: "bash", command: cmd, cwd: workdir } }];
  }
  if (p.type === "function_call" && (name === "shell" || name === "local_shell")) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(p.arguments ?? "{}"));
    } catch {
      return [];
    }
    return requestsFor({ tool_name: "shell", tool_input: args, cwd }).map((req) => ({ source: "codex", agentTool: name, req }));
  }
  if (p.type === "local_shell_call") {
    const action = (p.action ?? {}) as Record<string, unknown>;
    return requestsFor({ tool_name: "local_shell", tool_input: { command: action.command }, cwd }).map((req) => ({ source: "codex", agentTool: "local_shell", req }));
  }
  if ((p.type === "custom_tool_call" || p.type === "function_call") && name === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
    return requestsFor({ tool_name: "apply_patch", tool_input: { input: patch }, cwd }).map((req) => ({ source: "codex", agentTool: "apply_patch", req }));
  }
  return [];
}

function codexCalls(lines: Record<string, unknown>[]): ReplayCall[] {
  const calls: ReplayCall[] = [];
  let cwd: string | undefined;
  for (const o of lines) {
    const p = (o.payload ?? o) as Record<string, unknown>;
    if (o.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
    if (o.type === "turn_context" && typeof p.cwd === "string") cwd = p.cwd;
    if (o.type === "response_item" || p.type) calls.push(...codexItem(p, cwd));
  }
  return calls;
}

/**
 * A naive command-grep guard: the kind of PreToolUse hook people write with a
 * handful of substring/regex checks on the raw command string. It is used only
 * to show where such a guard would miss what agent-fence catches. It is never
 * used to make a decision.
 */
export const NAIVE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /rm\s+-rf?\s+\/(?:\s|$)/, label: "rm -rf /" },
  { re: /git\s+push\s+(?:\S+\s+)*(?:--force|-f)(?:\s|$)/, label: "git push --force / -f" },
  { re: /\.env(?:\s|$|:)/, label: ".env" },
  { re: /\bsudo\b/, label: "sudo" },
  { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, label: "curl | sh" },
  { re: /\bchmod\s+(?:-R\s+)?777\b/, label: "chmod 777" },
];

export function naiveWouldCatch(command: string): boolean {
  return NAIVE_PATTERNS.some((p) => p.re.test(command));
}

/** Evaluate one parsed transcript. Policies are cached per project root. */
export function evaluateCalls(calls: ReplayCall[]): ReplayResult[] {
  const cache = new Map<string, Policy>();
  const out: ReplayResult[] = [];
  for (const call of calls) {
    const cwd = call.req.cwd || process.cwd();
    let policy: Policy;
    try {
      const root = findProjectRoot(cwd);
      policy = cache.get(root) ?? cache.set(root, loadPolicy({ cwd, root })).get(root)!;
    } catch {
      continue;
    }
    const decision = evaluate(policy, call.req);
    const naiveCaught = call.req.tool === "bash" ? naiveWouldCatch(call.req.command ?? "") : false;
    out.push({ ...call, decision, naiveCaught });
  }
  return out;
}

export function parseTranscript(text: string, forceSource?: Source): { source: Source; calls: ReplayCall[] } {
  const lines = parseLines(text);
  const source = forceSource ?? detectSource(lines);
  if (!source) throw new Error("could not tell whether this is a Claude Code or Codex transcript (expected JSON lines)");
  return { source, calls: source === "claude" ? claudeCalls(lines) : codexCalls(lines) };
}

export function replayFile(file: string, forceSource?: Source): Replay {
  const { source, calls } = parseTranscript(readFileSync(file, "utf8"), forceSource);
  return { source, calls: calls.length, results: evaluateCalls(calls) };
}

/** A replay result reshaped for buildReport / formatReport. */
export function toRecord(res: ReplayResult): EvalRecord {
  const cwd = res.req.cwd || process.cwd();
  return {
    source: res.source,
    project: findProjectRoot(cwd),
    tool: res.req.tool,
    agentTool: res.agentTool,
    input: describeInput(res.req),
    action: res.decision.action,
    rule: res.decision.rule,
    layer: res.decision.layer,
    subject: res.decision.subject,
  };
}
