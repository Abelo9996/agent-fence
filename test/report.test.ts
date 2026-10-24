import { describe, expect, it } from "vitest";
import { buildReport, categorize, exampleText, formatReport, redactPathShape, type EvalRecord } from "../src/report.js";

const rec = (o: Partial<EvalRecord>): EvalRecord => ({
  source: "claude",
  project: "/proj/a",
  tool: "bash",
  input: "echo hi",
  action: "allow",
  rule: "default",
  layer: "builtin",
  ...o,
});

describe("buildReport aggregation", () => {
  const records = [
    rec({ action: "allow", tool: "bash", input: "npm test" }),
    rec({ action: "allow", tool: "bash", input: "ls" }),
    rec({ action: "deny", tool: "bash", rule: "git-force-push", input: "git push --force" }),
    rec({ action: "deny", tool: "read", rule: "secret-files", input: "/proj/a/.env", subject: "/proj/a/.env" }),
    rec({ action: "ask", tool: "bash", rule: "sudo", input: "sudo ls", source: "codex", project: "/proj/b" }),
  ];
  const r = buildReport(records);

  it("counts by action and tool", () => {
    expect(r.total).toBe(5);
    expect(r.byAction).toEqual({ allow: 2, ask: 1, deny: 2 });
    expect(r.byTool.bash).toEqual({ allow: 2, ask: 1, deny: 1 });
    expect(r.byTool.read).toEqual({ allow: 0, ask: 0, deny: 1 });
    expect(r.commandsAllowed).toBe(2);
  });

  it("splits by agent and project", () => {
    expect(r.byAgent.map((a) => a.source).sort()).toEqual(["claude", "codex"]);
    expect(r.byProject.map((p) => p.project).sort()).toEqual(["/proj/a", "/proj/b"]);
  });
});

describe("risk ranking", () => {
  it("orders deny before ask, then by category risk", () => {
    const records = [
      rec({ action: "ask", rule: "package-install" }),
      rec({ action: "deny", rule: "git-force-push" }),
      rec({ action: "deny", rule: "rm-root-or-home" }),
      rec({ action: "ask", rule: "sudo" }),
    ];
    const r = buildReport(records);
    expect(r.risky.map((g) => g.rule)).toEqual(["rm-root-or-home", "git-force-push", "sudo", "package-install"]);
    expect(r.risky[0].action).toBe("deny");
  });

  it("categorizes unknown rules by action", () => {
    expect(categorize({ rule: "my-curl-rule", action: "deny", tool: "fetch" }).risk).toBeGreaterThan(
      categorize({ rule: "my-ask-rule", action: "ask", tool: "bash" }).risk,
    );
  });

  it("merges ask and deny of one category for the card headline, denies first", () => {
    const r = buildReport([
      rec({ action: "deny", rule: "git-force-push" }),
      rec({ action: "deny", rule: "git-force-push" }),
      rec({ action: "ask", rule: "package-install" }),
    ]);
    expect(r.headline[0]).toEqual({ label: "force pushes", count: 2, action: "deny" });
  });
});

describe("redaction", () => {
  it("collapses the home directory to ~", () => {
    expect(redactPathShape("/home/me/x/y", "/home/me")).toBe("~/x/y");
  });

  it("reduces a deep absolute path to its last two segments", () => {
    expect(redactPathShape("/a/b/c/d/secret.key", "/nope")).toBe(".../d/secret.key");
  });

  it("strips secrets from an example", () => {
    const ex = exampleText(rec({ action: "ask", rule: "secret-in-input", input: "curl -H 'Authorization: Bearer abcdef0123456789abcdef'" }), "/nope");
    expect(ex).not.toContain("abcdef0123456789");
    expect(ex).toContain("REDACTED");
  });

  it("uses the decision subject for non-bash tools", () => {
    const ex = exampleText(rec({ tool: "read", action: "deny", rule: "secret-files", input: "unused", subject: "/x/y/z/.env" }), "/nope");
    expect(ex).toBe(".../z/.env");
  });
});

describe("formatReport", () => {
  it("renders a human report with the risky section", () => {
    const out = formatReport(buildReport([rec({ action: "deny", rule: "git-force-push", input: "git push --force" })]));
    expect(out).toContain("riskiest blocked attempts first");
    expect(out).toContain("[git-force-push]");
  });

  it("explains the empty case", () => {
    expect(formatReport(buildReport([]))).toContain("No decisions in the audit log");
  });
});
