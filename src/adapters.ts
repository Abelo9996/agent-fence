import { appendAudit } from "./audit.js";
import { evaluate, formatReason, type Decision, type Request } from "./engine.js";
import { findProjectRoot } from "./paths.js";
import { loadPolicy, severity, type Policy } from "./policy.js";

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Files touched by a Codex apply_patch payload, with the text being added. */
export function parseApplyPatch(patch: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  let cur: { path: string; content: string } | null = null;
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line) || /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) {
      cur = { path: (m[2] ?? m[1]).trim(), content: "" };
      files.push(cur);
      continue;
    }
    if (cur && line.startsWith("+")) cur.content += line.slice(1) + "\n";
  }
  return files;
}

/** Map one agent tool call onto the requests agent-fence checks. Empty when the tool is not covered. */
export function requestsFor(p: HookPayload): Request[] {
  const tool = p.tool_name ?? "";
  const input = p.tool_input ?? {};
  const cwd = p.cwd;
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (tool) {
    case "Bash":
    case "PowerShell":
    case "shell":
    case "local_shell": {
      const c = input.command;
      let command = Array.isArray(c) ? c.map(String).map(quoteArg).join(" ") : str(c);
      // PowerShell escapes with backticks, not backslashes, so backslashes there are path separators.
      if (tool === "PowerShell" && command) command = command.replace(/\\/g, "/");
      return command === undefined ? [] : [{ tool: "bash", command, cwd }];
    }
    case "apply_patch": {
      const patch = str(input.command) ?? str(input.patch) ?? str(input.input) ?? "";
      return parseApplyPatch(patch).map((f) => ({ tool: "write", path: f.path, content: f.content, cwd }));
    }
    case "Read":
    case "NotebookRead":
    case "Glob":
    case "Grep":
    case "LS":
      return filePath ? [{ tool: "read", path: filePath, cwd }] : [];
    case "Write":
      return filePath ? [{ tool: "write", path: filePath, content: str(input.content), cwd }] : [];
    case "Edit":
      return filePath ? [{ tool: "write", path: filePath, content: str(input.new_string), cwd }] : [];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const content = edits.map((e) => str((e as Record<string, unknown>)?.new_string) ?? "").join("\n");
      return filePath ? [{ tool: "write", path: filePath, content, cwd }] : [];
    }
    case "NotebookEdit":
      return filePath ? [{ tool: "write", path: filePath, content: str(input.new_source), cwd }] : [];
    case "WebFetch":
      return str(input.url) ? [{ tool: "fetch", url: str(input.url), cwd }] : [];
    default:
      return [];
  }
}

/** Quote one argv element for display and re-parsing. */
export function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
  return "'" + a.replace(/'/g, "'\\''") + "'";
}

export interface HookResult {
  /** JSON to print on stdout, or null to print nothing (let the agent's own permission flow decide). */
  stdout: string | null;
  decision: Decision | null;
}

function decide(policy: Policy, reqs: Request[]): Decision | null {
  let best: Decision | null = null;
  for (const r of reqs) {
    const d = evaluate(policy, r);
    if (!best || severity(d.action) > severity(best.action)) best = d;
  }
  return best;
}

/**
 * Handle one PreToolUse hook call for Claude Code or Codex. agent-fence never
 * grants permission: an allow decision prints nothing, so the agent's own
 * permission settings still apply.
 */
export function handleHook(agent: "claude" | "codex", raw: string, env: NodeJS.ProcessEnv = process.env): HookResult {
  let p: HookPayload;
  try {
    p = JSON.parse(raw || "{}");
  } catch {
    return { stdout: null, decision: null };
  }
  if (p.hook_event_name && p.hook_event_name !== "PreToolUse") return { stdout: null, decision: null };
  const cwd = p.cwd || process.cwd();
  const root = findProjectRoot(agent === "claude" && env.CLAUDE_PROJECT_DIR ? env.CLAUDE_PROJECT_DIR : cwd);
  const reqs = requestsFor({ ...p, cwd });
  if (!reqs.length) return { stdout: null, decision: null };

  let decision: Decision | null;
  try {
    const policy = loadPolicy({ cwd, root });
    decision = decide(policy, reqs);
  } catch (e) {
    decision = {
      action: "ask",
      reason: `The agent-fence policy could not be loaded: ${(e as Error).message}`,
      rule: "policy-error",
      layer: "builtin",
    };
  }
  if (!decision) return { stdout: null, decision: null };
  for (const req of reqs) {
    appendAudit({ source: agent, project: root, cwd, req, decision, agentTool: p.tool_name, session: p.session_id });
  }
  if (decision.action === "allow") return { stdout: null, decision };

  let permission: "deny" | "ask" = decision.action;
  let reason = formatReason(decision);
  if (agent === "codex" && permission === "ask") {
    // Codex hooks cannot ask (an "ask" result is ignored and the call runs), so
    // ask becomes deny with an instruction to get the user's approval.
    permission = "deny";
    reason += " Codex hooks cannot prompt, so this was blocked: ask the user to approve it and run it themselves, or to change the policy.";
  }
  if (permission === "deny" && decision.action === "deny") {
    reason += " Do not try to get around this with a different command; ask the user.";
  }
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: permission, permissionDecisionReason: reason } };
  return { stdout: JSON.stringify(out), decision };
}
