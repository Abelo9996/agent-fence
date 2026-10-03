import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { quoteArg } from "./adapters.js";
import { appendAudit } from "./audit.js";
import { evaluate, formatReason, type Decision, type Request } from "./engine.js";
import { findProjectRoot } from "./paths.js";
import { loadPolicy } from "./policy.js";

/** Exit code used when agent-fence refuses to run a command (same as "cannot execute"). */
export const BLOCKED_EXIT = 126;

function decideCommand(command: string, source: string): Decision {
  const cwd = process.cwd();
  const root = findProjectRoot(cwd);
  const req: Request = { tool: "bash", command, cwd };
  let decision: Decision;
  try {
    decision = evaluate(loadPolicy({ cwd, root }), req);
  } catch (e) {
    decision = { action: "deny", reason: `The agent-fence policy could not be loaded: ${(e as Error).message}`, rule: "policy-error", layer: "builtin" };
  }
  appendAudit({ source, project: root, cwd, req, decision });
  return decision;
}

/** Ask on the controlling terminal. Returns false when there is no terminal. */
function confirmOnTty(question: string): boolean {
  if (process.platform === "win32" || !process.stdin.isTTY || !process.stderr.isTTY) return false;
  process.stderr.write(question + " [y/N] ");
  const r = spawnSync("sh", ["-c", 'read -r a </dev/tty && printf %s "$a"'], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  return /^y(es)?$/i.test((r.stdout || "").trim());
}

/** Returns true when the command may run. Prints the reason when it may not. */
function gate(command: string, source: string): boolean {
  const d = decideCommand(command, source);
  if (d.action === "allow") return true;
  if (d.action === "ask" && process.env.AGENT_FENCE_ASK !== "deny" && confirmOnTty(formatReason(d) + " Run it?")) return true;
  const extra = d.action === "ask" ? " No terminal was available to ask, so it was not run; ask the user to run it." : "";
  process.stderr.write(formatReason(d) + extra + "\n");
  return false;
}

function finish(r: ReturnType<typeof spawnSync>): number {
  if (r.error) {
    process.stderr.write(`agent-fence: ${r.error.message}\n`);
    return 127;
  }
  if (r.signal) return 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 } as Record<string, number>)[r.signal] ?? 1);
  return r.status ?? 1;
}

/** `agent-fence exec -- cmd args...`: check, then run the argv directly (no shell). */
export function runExec(argv: string[]): number {
  if (!argv.length) {
    process.stderr.write("usage: agent-fence exec -- <command> [args...]\n");
    return 2;
  }
  if (!gate(argv.map(quoteArg).join(" "), "exec")) return BLOCKED_EXIT;
  return finish(spawnSync(argv[0], argv.slice(1), { stdio: "inherit", shell: process.platform === "win32" }));
}

/** The shell agent-fence-shell hands allowed commands to. */
export function realShell(): string {
  const env = process.env.AGENT_FENCE_REAL_SHELL;
  const self = process.argv[1] ? safeReal(process.argv[1]) : "";
  for (const cand of [env, "/bin/bash", "/bin/sh"]) {
    if (!cand || !existsSync(cand)) continue;
    if (self && safeReal(cand) === self) continue;
    return cand;
  }
  return "/bin/sh";
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Behave like `sh`: with `-c script`, check the script and hand it to the real
 * shell; with a script file, check the file's text first; with no script
 * (interactive), pass through unchecked.
 */
export function runShell(args: string[]): number {
  if (process.platform === "win32") {
    process.stderr.write("agent-fence shell is for POSIX shells; on Windows use agent-fence exec or the agent's hooks.\n");
    return 2;
  }
  let script: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      script = args.slice(i + 1).find((x) => !x.startsWith("-")) ?? "";
      break;
    }
    if (a === "-o" || a === "+o") {
      i++;
      continue;
    }
    if (!a.startsWith("-") && !a.startsWith("+")) {
      try {
        script = readFileSync(a, "utf8");
      } catch {
        script = null;
      }
      break;
    }
  }
  if (script !== null && !gate(script, "shell")) return BLOCKED_EXIT;
  return finish(spawnSync(realShell(), args, { stdio: "inherit" }));
}
