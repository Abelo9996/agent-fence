import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPolicy, type Policy } from "../src/policy.js";

const made: string[] = [];

export function tempDir(prefix = "agent-fence-test-"): string {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

export function cleanup(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * A fresh project directory plus isolated home, user policy and audit log, so
 * tests never read or write the real ones.
 */
export function sandbox(opts: { project?: string; user?: string } = {}) {
  const home = tempDir("agent-fence-home-");
  const root = tempDir("agent-fence-proj-");
  mkdirSync(path.join(root, ".git"));
  const userFile = path.join(home, "policy.toml");
  const log = path.join(home, "audit.jsonl");
  process.env.AGENT_FENCE_HOME_DIR = home;
  process.env.AGENT_FENCE_CONFIG = userFile;
  process.env.AGENT_FENCE_LOG = log;
  process.env.AGENT_FENCE_STATE_DIR = path.join(home, "state");
  process.env.CODEX_HOME = path.join(home, ".codex");
  delete process.env.AGENT_FENCE_NO_LOG;
  if (opts.project !== undefined) writeFileSync(path.join(root, ".agent-fence.toml"), opts.project);
  if (opts.user !== undefined) writeFileSync(userFile, opts.user);
  return { home, root, userFile, log, policy: (): Policy => loadPolicy({ cwd: root }) };
}

export function write(root: string, rel: string, content: string): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** A path outside the project and outside every temp directory. */
export function outsidePath(...rest: string[]): string {
  return path.join(path.parse(os.tmpdir()).root, "agent-fence-nonexistent", ...rest);
}

export const CLI = path.resolve(__dirname, "..", "dist", "cli.js");
export const SHELL = path.resolve(__dirname, "..", "dist", "shell.js");

export function runCli(args: string[], opts: { cwd: string; input?: string; env?: NodeJS.ProcessEnv }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export { execFileSync };
