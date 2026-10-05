import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/adapters.js";
import { readAudit } from "../src/audit.js";
import { evaluate } from "../src/engine.js";
import { loadPolicy } from "../src/policy.js";
import { CLAUDE_MATCHER, CODEX_MATCHER } from "../src/hooks.js";
import { cleanup, runCli, sandbox, tempDir, write } from "./helpers.js";

const REPO = path.resolve(__dirname, "..");
const LAUNCHER = path.join(REPO, "hooks", "run.mjs");
const WIN = process.platform === "win32";
const json = (rel: string) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));

afterEach(cleanup);

describe("Claude Code plugin files", () => {
  it("plugin.json matches package.json", () => {
    const manifest = json(".claude-plugin/plugin.json");
    const pkg = json("package.json");
    expect(manifest.name).toBe("agent-fence");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  it("hooks.json registers the same PreToolUse matcher as `agent-fence hooks install`", () => {
    const { hooks } = json("hooks/hooks.json");
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    expect(hooks.PreToolUse[0].matcher).toBe(CLAUDE_MATCHER);
    const [h] = hooks.PreToolUse[0].hooks;
    expect(h).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "hook", "claude"] });
    expect(h.async).toBeUndefined();
  });

  it("every slash command has a description, runs only when the user asks, and can run the CLI", () => {
    const files = readdirSync(path.join(REPO, "commands")).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["explain.md", "log.md"]);
    for (const f of files) {
      const text = readFileSync(path.join(REPO, "commands", f), "utf8").replace(/\r\n/g, "\n");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(front, f).toMatch(/^description: \S/m);
      expect(front, f).toMatch(/^disable-model-invocation: true$/m);
      expect(front, f).toContain("Bash(npx -y @abelo9996/agent-fence *)");
    }
  });
});

describe("Codex plugin files", () => {
  it("plugin.json matches package.json and points at the skills, hooks and icon", () => {
    const manifest = json(".codex-plugin/plugin.json");
    const pkg = json("package.json");
    expect(manifest.name).toBe("agent-fence");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.hooks).toBe("./hooks/codex-hooks.json");
    expect(manifest.interface.composerIcon).toBe("./assets/icon.svg");
    const svg = readFileSync(path.join(REPO, "assets", "icon.svg"), "utf8");
    expect(svg).toMatch(/viewBox="0 0 512 512"/);
    expect(Buffer.byteLength(svg)).toBeLessThan(50_000);
  });

  it("codex-hooks.json runs `agent-fence hook codex` for the same tools as `agent-fence hooks install --agent codex`", () => {
    const { hooks } = json("hooks/codex-hooks.json");
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    expect(hooks.PreToolUse[0].matcher).toBe(CODEX_MATCHER);
    expect(hooks.PreToolUse[0].hooks[0].command).toBe("npx -y @abelo9996/agent-fence hook codex");
  });
});

/** A fake executable named `name` in `dir` that reports how it was called, then exits 3. */
function fakeTool(dir: string, name: string): void {
  const js =
    "const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{" +
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:Buffer.concat(c).toString(),via:process.env.AGENT_FENCE_VIA_PLUGIN}));" +
    "process.exit(3)});";
  if (name === "agent-fence" && WIN) {
    write(dir, "agent-fence.cmd", "@echo off\r\n");
    write(dir, "node_modules/@abelo9996/agent-fence/dist/cli.js", js);
  } else if (WIN) {
    write(dir, "fake.js", js);
    write(dir, `${name}.cmd`, `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  } else {
    write(dir, name, `#!${process.execPath}\n${js}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
}

function launch(pathDirs: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
  env.PATH = pathDirs.join(path.delimiter);
  const r = spawnSync(process.execPath, [LAUNCHER, "hook", "claude"], { input: '{"tool_name":"Bash"}', env, encoding: "utf8" });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
}

describe("hook launcher (hooks/run.mjs)", () => {
  it("prefers a global install on PATH and passes stdin, stdout and the exit code through", () => {
    const global = tempDir();
    const npx = tempDir();
    fakeTool(global, "agent-fence");
    fakeTool(npx, "npx");
    const r = launch([global, npx]);
    expect(r.code).toBe(3);
    expect(r.out).toEqual({ args: ["hook", "claude"], stdin: '{"tool_name":"Bash"}', via: "1" });
  });

  it("falls back to npx when agent-fence is not installed", () => {
    const npx = tempDir();
    fakeTool(npx, "npx");
    const r = launch([npx]);
    expect(r.code).toBe(3);
    expect(r.out).toEqual({ args: ["-y", "@abelo9996/agent-fence", "hook", "claude"], stdin: '{"tool_name":"Bash"}', via: "1" });
  });

  it("skips npx's temporary shim directories", () => {
    const shim = path.join(tempDir(), "_npx", "abc", "node_modules", ".bin");
    fakeTool(shim, "agent-fence");
    const npx = tempDir();
    fakeTool(npx, "npx");
    expect(launch([shim, npx]).out.args[0]).toBe("-y");
  });
});

describe("plugin hooks in the audit log", () => {
  const payload = (root: string) =>
    JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

  it("marks decisions made through a plugin and hooks status reports them", () => {
    const { root, log } = sandbox();
    handleHook("claude", payload(root), {});
    handleHook("claude", payload(root), { AGENT_FENCE_VIA_PLUGIN: "1" });
    handleHook("codex", payload(root), { PLUGIN_ROOT: "/plugins/agent-fence" });
    expect(readAudit(log).map((e) => [e.source, e.plugin])).toEqual([
      ["claude", undefined],
      ["claude", true],
      ["codex", true],
    ]);
    expect(runCli(["hooks", "status", "--agent", "claude"], { cwd: root }).stdout).toMatch(/^plugin +active .* through the Claude Code plugin$/m);
    expect(runCli(["hooks", "status", "--agent", "codex"], { cwd: root }).stdout).toMatch(/through the Codex plugin/);
  });

  it("does not report a plugin when only settings hooks ran", () => {
    const { root } = sandbox();
    handleHook("claude", payload(root), {});
    expect(runCli(["hooks", "status", "--agent", "claude"], { cwd: root }).stdout).not.toContain("plugin");
  });
});

describe("protect-fence-cli", () => {
  it("blocks agents from disabling or removing the agent-fence plugin", () => {
    const { root } = sandbox();
    const policy = loadPolicy({ cwd: root });
    for (const cmd of [
      "claude plugin disable agent-fence@open-agent-lab",
      "claude plugin uninstall agent-fence@open-agent-lab --scope user",
      "claude plugins remove agent-fence",
      "codex plugin remove agent-fence@open-agent-lab",
    ]) {
      const d = evaluate(policy, { tool: "bash", command: cmd, cwd: root });
      expect(d.rule, cmd).toBe("protect-fence-cli");
      expect(d.action, cmd).toBe("deny");
    }
    const other = evaluate(policy, { tool: "bash", command: "claude plugin disable some-other-plugin", cwd: root });
    expect(other.rule).not.toBe("protect-fence-cli");
  });
});
