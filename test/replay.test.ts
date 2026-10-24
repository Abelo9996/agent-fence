import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { detectSource, evaluateCalls, naiveWouldCatch, parseTranscript } from "../src/replay.js";

// Isolate from the real user policy so decisions come from the built-in rules only.
const saved = { cfg: process.env.AGENT_FENCE_CONFIG, home: process.env.AGENT_FENCE_HOME_DIR, noLog: process.env.AGENT_FENCE_NO_LOG };
beforeAll(() => {
  process.env.AGENT_FENCE_CONFIG = path.join(os.tmpdir(), "af-replay-no-such-policy.toml");
  process.env.AGENT_FENCE_HOME_DIR = path.join(os.tmpdir(), "af-replay-home");
  process.env.AGENT_FENCE_NO_LOG = "1";
});
afterAll(() => {
  for (const [k, v] of [["AGENT_FENCE_CONFIG", saved.cfg], ["AGENT_FENCE_HOME_DIR", saved.home], ["AGENT_FENCE_NO_LOG", saved.noLog]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const claudeLog = [
  JSON.stringify({ type: "user", message: { content: "hi" } }),
  JSON.stringify({ type: "assistant", cwd: "/proj", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
  JSON.stringify({ type: "assistant", cwd: "/proj", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push --force-with-lease=main:abc123 origin" } }] } }),
  JSON.stringify({ type: "assistant", cwd: "/proj", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/proj/.env" } }] } }),
].join("\n");

const codexLog = [
  JSON.stringify({ type: "session_meta", payload: { cwd: "/proj" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git push --force", workdir: "/proj" }) } }),
  JSON.stringify({ type: "turn_context", payload: { cwd: "/proj" } }),
  JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: /etc/hosts\n+evil\n*** End Patch" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la", workdir: "/proj" }) } }),
].join("\n");

describe("detectSource", () => {
  it("recognizes a Claude transcript", () => {
    expect(parseTranscript(claudeLog).source).toBe("claude");
  });
  it("recognizes a Codex transcript", () => {
    expect(parseTranscript(codexLog).source).toBe("codex");
  });
  it("throws on an unknown format", () => {
    expect(() => parseTranscript('{"foo":1}\n{"bar":2}')).toThrow(/Claude|Codex/);
  });
  it("is overridable", () => {
    expect(detectSource([{ type: "whatever" }])).toBeNull();
  });
});

describe("Claude parsing", () => {
  const { calls } = parseTranscript(claudeLog);
  it("maps tool_use entries to requests", () => {
    expect(calls.map((c) => c.req.tool)).toEqual(["bash", "bash", "read"]);
    expect(calls[0].req.command).toBe("npm test");
    expect(calls[2].req.path).toBe("/proj/.env");
  });
  it("evaluates force-push and secret read as blocked", () => {
    const res = evaluateCalls(calls);
    expect(res.find((r) => r.req.command?.includes("force-with-lease"))!.decision.rule).toBe("git-force-push");
    expect(res.find((r) => r.req.tool === "read")!.decision.action).toBe("deny");
  });
});

describe("Codex parsing", () => {
  const { calls } = parseTranscript(codexLog);
  it("reads exec_command cmd and apply_patch files", () => {
    expect(calls[0].req.command).toBe("git push --force");
    expect(calls[0].req.cwd).toBe("/proj");
    const patch = calls.find((c) => c.req.tool === "write");
    expect(patch?.req.path).toBe("/etc/hosts");
  });
  it("evaluates a write outside the project as denied", () => {
    const res = evaluateCalls(calls);
    expect(res.find((r) => r.req.path === "/etc/hosts")!.decision.rule).toBe("write-outside-project");
  });
});

describe("naiveWouldCatch", () => {
  it("catches the obvious literal cases", () => {
    expect(naiveWouldCatch("rm -rf / ")).toBe(true);
    expect(naiveWouldCatch("git push --force origin main")).toBe(true);
    expect(naiveWouldCatch("sudo apt install x")).toBe(true);
  });
  it("misses the cases agent-fence still catches", () => {
    // force-with-lease is not a bare --force / -f token
    expect(naiveWouldCatch("git push --force-with-lease=main:abc origin")).toBe(false);
    // chained command and a plain push
    expect(naiveWouldCatch("cd app && git push origin main")).toBe(false);
  });
});
