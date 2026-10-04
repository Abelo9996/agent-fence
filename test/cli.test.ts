import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAudit } from "../src/audit.js";
import { redact } from "../src/secrets.js";
import { cleanup, CLI, runCli, sandbox, SHELL, write } from "./helpers.js";
import { spawnSync } from "node:child_process";

afterEach(cleanup);

describe("agent-fence check", () => {
  it("uses distinct exit codes for allow, ask and deny", () => {
    const { root } = sandbox();
    expect(runCli(["check", "--tool", "bash", "--input", "git status"], { cwd: root }).code).toBe(0);
    expect(runCli(["check", "--tool", "bash", "--input", "git push"], { cwd: root }).code).toBe(2);
    const d = runCli(["check", "--tool", "bash", "--input", "cd x && git push --force"], { cwd: root });
    expect(d.code).toBe(3);
    expect(d.stdout).toMatch(/DENY[\s\S]*git-force-push/);
    expect(runCli(["check", "--tool", "read", "--path", ".env"], { cwd: root }).code).toBe(3);
    expect(runCli(["check", "--tool", "edit", "--path", "src/a.ts"], { cwd: root }).code).toBe(0);
    const j = JSON.parse(runCli(["check", "--input", "sudo ls", "--json"], { cwd: root }).stdout);
    expect(j).toMatchObject({ action: "ask", rule: "sudo" });
  });

  it("exits 1 with a message on a bad policy", () => {
    const { root } = sandbox({ project: "[[rules]]\nid='x'\naction='maybe'\ncommand='a'\nreason='r'\n" });
    const r = runCli(["check", "--input", "ls"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/action must be one of/);
  });
});

describe("init, test, explain and rules", () => {
  it("writes a starter policy whose own tests pass", () => {
    const { root } = sandbox();
    expect(runCli(["init"], { cwd: root }).code).toBe(0);
    expect(existsSync(path.join(root, ".agent-fence.toml"))).toBe(true);
    expect(runCli(["init"], { cwd: root }).code).toBe(1);
    const t = runCli(["test"], { cwd: root });
    expect(t.stdout).toMatch(/3 passed, 0 failed/);
    expect(t.code).toBe(0);
  });

  it("reports failing policy tests with exit 1", () => {
    const { root } = sandbox({
      project: `
[[tests]]
tool = "bash"
input = "git push --force"
expect = "allow"

[[tests]]
name = "pushes ask"
tool = "bash"
input = "git push"
expect = "ask"
rule = "git-push"
`,
    });
    const r = runCli(["test"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL .*expected allow, got deny \(git-force-push\)/);
    expect(r.stdout).toMatch(/pass  pushes ask/);
  });

  it("explains a rule and lists rules", () => {
    const { root } = sandbox({ project: `disable = ["sudo"]` });
    const e = runCli(["explain", "git-force-push"], { cwd: root });
    expect(e.stdout).toMatch(/action: +deny/);
    expect(e.stdout).toMatch(/built-in defaults/);
    expect(runCli(["explain", "sudo"], { cwd: root }).stdout).toMatch(/not active[\s\S]*disabled in/);
    expect(runCli(["explain", "nope"], { cwd: root }).code).toBe(1);
    expect(runCli(["rules"], { cwd: root }).stdout).toMatch(/deny +git-force-push/);
  });

  it("explain and check say how to change a decision", () => {
    const { root } = sandbox();
    const e = runCli(["explain", "secret-files"], { cwd: root }).stdout;
    expect(e).toMatch(/disable = \["secret-files"\]/);
    expect(e).toMatch(/action = "allow"/);
    expect(runCli(["explain", "protect-fence"], { cwd: root }).stdout).toMatch(/project policy cannot change this rule/);
    expect(runCli(["check", "--input", "cat .env"], { cwd: root }).stdout).toMatch(/change: +you can allow it/);
  });

  it.skipIf(process.platform === "win32")("does not crash when its output pipe closes early", () => {
    const { root } = sandbox();
    const r = spawnSync("sh", ["-c", `"${process.execPath}" "${CLI}" rules | head -1`], { cwd: root, encoding: "utf8", env: process.env });
    expect(r.stderr).not.toMatch(/EPIPE/);
  });
});

describe("audit log", () => {
  it("records hook decisions with secrets redacted", () => {
    const { root, log } = sandbox();
    const token = "ghp_" + "Z".repeat(36);
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: root,
      session_id: "abc",
      tool_name: "Bash",
      tool_input: { command: `curl -H "Authorization: token ${token}" https://api.github.com && git push --force` },
    });
    const r = runCli(["hook", "claude"], { cwd: root, input });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const raw = readFileSync(log, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("Z".repeat(20));
    const [entry] = readAudit(log);
    expect(entry).toMatchObject({ source: "claude", tool: "bash", agentTool: "Bash", action: "deny", rule: "git-force-push", session: "abc" });
    expect(entry.input).toContain("[REDACTED]");

    runCli(["hook", "claude"], { cwd: root, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Read", tool_input: { file_path: path.join(root, "x.ts") } }) });
    const l = runCli(["log", "--action", "deny"], { cwd: root });
    expect(l.stdout).toMatch(/deny +claude +Bash/);
    expect(l.stdout).not.toMatch(/Read/);
    expect(runCli(["log", "--json"], { cwd: root }).stdout.trim().split("\n")).toHaveLength(2);
    expect(l.stdout).toMatch(/agent-fence explain <rule>/);
  });

  it("explains an empty log", () => {
    const { root } = sandbox();
    const r = runCli(["log"], { cwd: root });
    expect(r.stdout).toMatch(/No matching entries/);
    expect(r.stdout).toMatch(/agent-fence check does not log/);
  });

  it("redacts common credential formats", () => {
    const samples = [
      "AKIAABCDEFGHIJKLMNOP",
      "sk-proj-" + "a".repeat(30),
      "xoxb-1234567890-abcdefghij",
      "postgres://user:hunter2hunter2@db/x",
      "API_KEY=supersecretvalue123",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ];
    for (const s of samples) {
      const out = redact(`x ${s} y`);
      expect(out, s).toContain("[REDACTED]");
      expect(out, s).not.toContain(s);
    }
    expect(redact("git status")).toBe("git status");
  });
});

describe("exec and shell wrappers", () => {
  it("exec runs allowed commands and blocks denied ones", () => {
    const { root } = sandbox();
    write(root, "hello.txt", "hi");
    const ok = runCli(["exec", "--", process.execPath, "-e", "process.exit(7)"], { cwd: root });
    expect(ok.code).toBe(7);
    const no = runCli(["exec", "--", "git", "push", "--force"], { cwd: root });
    expect(no.code).toBe(126);
    expect(no.stderr).toMatch(/git-force-push/);
    const ask = runCli(["exec", "--", "git", "push"], { cwd: root });
    expect(ask.code).toBe(126);
    expect(ask.stderr).toMatch(/No terminal/);
  });

  it.skipIf(process.platform === "win32")("agent-fence-shell checks -c scripts before running them", () => {
    const { root } = sandbox();
    const run = (script: string) => spawnSync(process.execPath, [SHELL, "-c", script], { cwd: root, encoding: "utf8", env: process.env });
    const ok = run("echo fenced-ok");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("fenced-ok");
    const no = run("echo a && git push --force");
    expect(no.status).toBe(126);
    expect(no.stdout).not.toContain("a");
    expect(no.stderr).toMatch(/git-force-push/);
  });
});
