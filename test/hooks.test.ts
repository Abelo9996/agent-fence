import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleHook, parseApplyPatch } from "../src/adapters.js";
import { exportCodexRules } from "../src/codex-rules.js";
import { codexHookTrusted, hookInstalled, hookTarget, installHook, uninstallHook, CLAUDE_MATCHER } from "../src/hooks.js";
import { loadPolicy } from "../src/policy.js";
import { cleanup, sandbox } from "./helpers.js";

afterEach(cleanup);

function payload(root: string, tool_name: string, tool_input: Record<string, unknown>) {
  return JSON.stringify({
    session_id: "s1",
    transcript_path: path.join(root, "t.jsonl"),
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    tool_use_id: "toolu_1",
  });
}

describe("Claude Code PreToolUse round trip", () => {
  it("denies with a reason in the documented shape", () => {
    const { root } = sandbox();
    const r = handleHook("claude", payload(root, "Bash", { command: "cd app && git push --force", description: "push" }), {});
    const out = JSON.parse(r.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/git-force-push/);
  });

  it("asks for ask rules", () => {
    const { root } = sandbox();
    const out = JSON.parse(handleHook("claude", payload(root, "Bash", { command: "git push" }), {}).stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("prints nothing on allow so Claude Code's own permissions still apply", () => {
    const { root } = sandbox();
    const r = handleHook("claude", payload(root, "Bash", { command: "npm test" }), {});
    expect(r.stdout).toBeNull();
    expect(r.decision?.action).toBe("allow");
  });

  it("maps file tools to read and write checks", () => {
    const { root } = sandbox();
    const decide = (tool: string, input: Record<string, unknown>) => {
      const s = handleHook("claude", payload(root, tool, input), {}).stdout;
      return s ? JSON.parse(s).hookSpecificOutput.permissionDecision : "allow";
    };
    expect(decide("Read", { file_path: path.join(root, ".env") })).toBe("deny");
    expect(decide("Read", { file_path: path.join(root, "src", "a.ts") })).toBe("allow");
    expect(decide("Write", { file_path: path.join(root, ".agent-fence.toml"), content: "" })).toBe("deny");
    expect(decide("Edit", { file_path: path.join(root, "a.ts"), old_string: "a", new_string: "const t = 'ghp_" + "a".repeat(36) + "'" })).toBe("ask");
    expect(decide("MultiEdit", { file_path: path.join(root, ".claude", "settings.json"), edits: [] })).toBe("deny");
    expect(decide("mcp__github__create_issue", { title: "x" })).toBe("allow");
  });

  it("uses CLAUDE_PROJECT_DIR to find the project policy", () => {
    const { root } = sandbox({ project: `[[rules]]\nid="no-make"\naction="deny"\ncommand="make"\nreason="r"\n` });
    const sub = path.join(root, "pkg");
    mkdirSync(sub);
    const p = JSON.parse(payload(root, "Bash", { command: "make" }));
    p.cwd = sub;
    const out = JSON.parse(handleHook("claude", JSON.stringify(p), { CLAUDE_PROJECT_DIR: root }).stdout!);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/no-make/);
  });

  it("asks instead of crashing when the policy is broken", () => {
    const { root } = sandbox({ project: "this is = = not toml" });
    const out = JSON.parse(handleHook("claude", payload(root, "Bash", { command: "ls" }), {}).stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not be loaded/);
  });

  it("ignores other events and garbage input", () => {
    const { root } = sandbox();
    expect(handleHook("claude", "not json", {}).stdout).toBeNull();
    const p = JSON.parse(payload(root, "Bash", { command: "git push --force" }));
    p.hook_event_name = "PostToolUse";
    expect(handleHook("claude", JSON.stringify(p), {}).stdout).toBeNull();
  });
});

describe("Codex PreToolUse round trip", () => {
  it("denies Bash commands and turns ask into deny (Codex hooks cannot ask)", () => {
    const { root } = sandbox();
    const deny = JSON.parse(handleHook("codex", payload(root, "Bash", { command: "git push --force" }), {}).stdout!);
    expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
    const ask = JSON.parse(handleHook("codex", payload(root, "Bash", { command: "git push" }), {}).stdout!);
    expect(ask.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(ask.hookSpecificOutput.permissionDecisionReason).toMatch(/ask the user/);
  });

  it("checks every file in an apply_patch", () => {
    const { root } = sandbox();
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "+ok", "*** Add File: .env", "+SECRET=1", "*** End Patch"].join("\n");
    expect(parseApplyPatch(patch).map((f) => f.path)).toEqual(["src/a.ts", ".env"]);
    const out = JSON.parse(handleHook("codex", payload(root, "apply_patch", { command: patch }), {}).stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/secret-files/);
  });

  it("exports command rules as Codex prefix_rule lines", () => {
    const { root } = sandbox();
    const ex = exportCodexRules(loadPolicy({ cwd: root }));
    expect(ex.text).toContain('prefix_rule(pattern=["git", "push", "--force"], decision="forbidden"');
    expect(ex.text).toContain('prefix_rule(pattern=["git", "push"], decision="prompt"');
    expect(ex.text).toContain('["install", "i", "add", "ci", "uninstall", "update"]');
    expect(ex.skipped.some((s) => s.rule === "secret-in-input")).toBe(true);
  });
});

describe("hook installation", () => {
  it("merges into existing Claude settings without clobbering and backs up first", () => {
    const { root } = sandbox();
    const file = path.join(root, ".claude", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const before = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }], Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
      model: "x",
    };
    writeFileSync(file, JSON.stringify(before));
    const t = hookTarget("claude", root);
    const r = installHook(t, "agent-fence");
    expect(r.changed).toBe(true);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toBe("x");
    expect(after.hooks.Stop).toEqual(before.hooks.Stop);
    expect(after.hooks.PreToolUse[0]).toEqual(before.hooks.PreToolUse[0]);
    expect(after.hooks.PreToolUse[1]).toEqual({ matcher: CLAUDE_MATCHER, hooks: [{ type: "command", command: "agent-fence hook claude", timeout: 30 }] });

    // idempotent
    expect(installHook(t, "agent-fence").changed).toBe(false);
    // a different command replaces ours, not adds a second one
    installHook(t, "node /x/agent-fence/dist/cli.js");
    const again = JSON.parse(readFileSync(file, "utf8"));
    expect(again.hooks.PreToolUse).toHaveLength(2);
    expect(again.hooks.PreToolUse[1].hooks[0].command).toBe("node /x/agent-fence/dist/cli.js hook claude");

    const u = uninstallHook(t);
    expect(u.removed).toBe(1);
    const removed = JSON.parse(readFileSync(file, "utf8"));
    expect(removed).toEqual(before);
    expect(hookInstalled(t)).toBe(false);
  });

  it("writes settings.json only with shared, and refuses to touch invalid JSON", () => {
    const { root } = sandbox();
    const shared = hookTarget("claude", root, { shared: true });
    expect(shared.file.endsWith(path.join(".claude", "settings.json"))).toBe(true);
    installHook(shared, "agent-fence");
    expect(hookInstalled(shared)).toBe(true);
    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(false);

    const local = hookTarget("claude", root);
    writeFileSync(local.file, "{ not json");
    expect(() => installHook(local, "agent-fence")).toThrow(/not valid JSON/);
    expect(readFileSync(local.file, "utf8")).toBe("{ not json");
    expect(readdirSync(path.dirname(local.file)).some((f) => f.includes("backup"))).toBe(false);
  });

  it("installs the Codex hook in CODEX_HOME/hooks.json", () => {
    const { home, root } = sandbox();
    const t = hookTarget("codex", root);
    expect(t.file).toBe(path.join(home, ".codex", "hooks.json"));
    installHook(t, "agent-fence");
    const s = JSON.parse(readFileSync(t.file, "utf8"));
    expect(s.hooks.PreToolUse[0].matcher).toContain("apply_patch");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("agent-fence hook codex");
  });

  it("reports whether Codex has recorded trust for the hook", () => {
    const { home, root } = sandbox();
    const t = hookTarget("codex", root);
    installHook(t, "agent-fence");
    expect(codexHookTrusted(t)).toBe(false);
    // the shape Codex 0.160 writes after "Trust all and continue"
    writeFileSync(path.join(home, ".codex", "config.toml"), `[hooks.state]\n\n[hooks.state."${t.file.replace(/\\/g, "\\\\")}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`);
    expect(codexHookTrusted(t)).toBe(true);
  });

  it("ends the Codex reason without a period, since Codex appends its own", () => {
    const { root } = sandbox();
    const r = JSON.parse(handleHook("codex", payload(root, "Bash", { command: "cat .env" }), {}).stdout!).hookSpecificOutput.permissionDecisionReason;
    expect(r).not.toMatch(/\.$/);
    expect(r).toMatch(/agent-fence explain secret-files/);
  });
});
