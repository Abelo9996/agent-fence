import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintPolicy, untestedRules } from "../src/lint.js";
import { runPolicyTests } from "../src/policy-tests.js";
import { STARTER_POLICY } from "../src/defaults.js";
import { cleanup, runCli, sandbox, write } from "./helpers.js";

afterEach(cleanup);

const SHADOWED = `
[[rules]]
id = "allow-push"
action = "allow"
command = "git push"
reason = "Loses to the built-in git-push rule on a tie."

[[rules]]
id = "deploy"
action = "deny"
command = "terraform apply"
reason = "Production deploys go through CI."

[[rules]]
id = "deploy-ask"
action = "ask"
command = "terraform apply"
reason = "Same pattern as deploy, weaker action."

[[rules]]
id = "env-ok"
action = "allow"
path = "**/.env"
reason = "Loses to secret-files."

[[rules]]
id = "allow-push-prio"
action = "allow"
command = "git push origin feature/*"
priority = 50
reason = "Priority makes this one win."

[[rules]]
id = "docs"
action = "allow"
url = "https://docs.example.com/*"
reason = "Docs are fine."

[[rules]]
id = "regex"
action = "ask"
command_regex = "^make deploy"
reason = "Cannot be turned into an example."
`;

describe("lintPolicy", () => {
  it("finds no shadowed rules among the built-in defaults", () => {
    const { policy } = sandbox();
    const r = lintPolicy(policy(), { layers: ["builtin"] });
    expect(r.checked.length).toBeGreaterThan(10);
    expect(r.shadowed).toEqual([]);
  });

  it("finds no shadowed rules in the starter policy", () => {
    const { policy } = sandbox({ project: STARTER_POLICY });
    expect(lintPolicy(policy()).shadowed).toEqual([]);
  });

  it("reports rules that never decide, with the winner and why", () => {
    const { policy } = sandbox({ project: SHADOWED });
    const r = lintPolicy(policy());
    const byId = Object.fromEntries(r.shadowed.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["allow-push", "deploy-ask", "env-ok"]);
    expect(byId["allow-push"]).toMatchObject({ example: 'bash "git push"', winner: { id: "git-push", layer: "builtin", action: "ask" } });
    expect(byId["allow-push"].why).toMatch(/ask beats allow/);
    expect(byId["deploy-ask"].winner.id).toBe("deploy");
    expect(byId["env-ok"]).toMatchObject({ example: 'read ".env"', winner: { id: "secret-files" } });
    expect(r.notChecked).toEqual(["regex"]);
    expect(r.checked).toContain("docs");
    expect(r.checked).toContain("allow-push-prio");
  });

  it("explains a project rule that cannot loosen a user rule", () => {
    const { policy } = sandbox({
      user: `[[rules]]\nid = "no-curl"\naction = "deny"\ncommand = "curl"\nreason = "No network."\n`,
      project: `[[rules]]\nid = "curl-api"\naction = "allow"\ncommand = "curl https://api.example.com/*"\nreason = "Our API."\n`,
    });
    const [s] = lintPolicy(policy()).shadowed;
    expect(s).toMatchObject({ id: "curl-api", winner: { id: "no-curl", layer: "user" } });
    expect(s.why).toMatch(/cannot loosen user rule "no-curl"/);
  });

  it("lists rules no test is decided by", () => {
    const { policy } = sandbox({
      project: `${SHADOWED}\n[[tests]]\ntool = "bash"\ninput = "terraform apply"\nexpect = "deny"\n\n[[tests]]\ntool = "fetch"\nurl = "https://docs.example.com/x"\nexpect = "allow"\nrule = "docs"\n`,
    });
    const p = policy();
    const untested = untestedRules(p, runPolicyTests(p));
    expect(untested).not.toContain("deploy");
    expect(untested).not.toContain("docs");
    expect(untested).toContain("env-ok");
  });
});

describe("agent-fence lint, test --json and --policy", () => {
  it("lint exits 1 on shadowed rules and 0 on a clean policy", () => {
    const { root } = sandbox({ project: SHADOWED });
    const r = runCli(["lint"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/shadowed +rule "allow-push"/);
    expect(r.stdout).toMatch(/skipped +regex/);
    const j = JSON.parse(runCli(["lint", "--json"], { cwd: root }).stdout);
    expect(j.shadowed.map((s: { id: string }) => s.id).sort()).toEqual(["allow-push", "deploy-ask", "env-ok"]);
    const clean = sandbox({ project: STARTER_POLICY });
    const ok = runCli(["lint"], { cwd: clean.root });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/no shadowed rules/);
  });

  it("test warns about shadowed rules and fails on them only with --strict", () => {
    const { root } = sandbox({ project: `${SHADOWED}\n[[tests]]\ntool = "bash"\ninput = "terraform apply"\nexpect = "deny"\n` });
    const r = runCli(["test"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 passed, 0 failed/);
    expect(r.stdout).toMatch(/3 shadowed rules \(warning; --strict makes this fail\)/);
    expect(runCli(["test", "--strict"], { cwd: root }).code).toBe(1);
  });

  it("test --json reports passes, failures, shadowed and untested rules", () => {
    const { root } = sandbox({
      project: `${SHADOWED}
[[tests]]
name = "deploys are blocked"
tool = "bash"
input = "terraform apply"
expect = "deny"

[[tests]]
tool = "bash"
input = "git push"
expect = "allow"
`,
    });
    const r = runCli(["test", "--json"], { cwd: root });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ passed: 1, failed: 1, rules: 7 });
    expect(j.tests[0]).toMatchObject({ name: "deploys are blocked", pass: true, action: "deny", rule: "deploy" });
    expect(j.tests[1]).toMatchObject({ subject: "git push", expect: "allow", pass: false, action: "ask", rule: "git-push" });
    expect(j.shadowed).toHaveLength(3);
    expect(j.untested).toContain("env-ok");
  });

  it("test --json prints a policy error as JSON", () => {
    const { root } = sandbox({ project: "[[rules]]\nid = 'x'\naction = 'maybe'\ncommand = 'a'\nreason = 'r'\n" });
    const r = runCli(["test", "--json"], { cwd: root });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/action must be one of/);
  });

  it("--policy loads another file as the project policy, rooted at its directory", () => {
    const { root } = sandbox();
    const file = write(root, "policies/ci/strict.toml", `
[[rules]]
id = "no-migrations"
action = "deny"
path = "db/**"
reason = "Reviewed by a human."

[[tests]]
tool = "write"
path = "db/001.sql"
expect = "deny"
rule = "no-migrations"
`);
    const r = runCli(["--policy", file, "test"], { cwd: root });
    expect(r.stdout).toMatch(/1 passed, 0 failed/);
    expect(r.code).toBe(0);
    const rel = runCli(["test", "--policy", path.join("policies", "ci", "strict.toml"), "--json"], { cwd: root });
    expect(JSON.parse(rel.stdout).passed).toBe(1);
    const check = runCli(["check", "--policy", file, "--tool", "write", "--path", path.join(root, "policies", "ci", "db", "x.sql")], { cwd: root });
    expect(check.code).toBe(3);
    const missing = runCli(["test", "--policy", "nope.toml"], { cwd: root });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/nope\.toml: policy file not found/);
  });
});
