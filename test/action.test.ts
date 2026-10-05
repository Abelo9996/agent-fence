import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderLog, renderMarkdown } from "../action/summary.mjs";
import { cleanup, runCli } from "./helpers.js";

afterEach(cleanup);

const repo = path.resolve(__dirname, "..");
const actionYml = readFileSync(path.join(repo, "action.yml"), "utf8");

function inputDefault(name: string): string | undefined {
  const m = new RegExp(`\\n  ${name}:\\n(?:    .*\\n)*?    default: (.*)\\n`).exec(actionYml);
  return m?.[1].replace(/^"(.*)"$/, "$1");
}

function cliJson(policy: string) {
  const r = runCli(["test", "--policy", policy, "--json"], { cwd: repo, env: { AGENT_FENCE_CONFIG: path.join(repo, "no-such-user-policy.toml") } });
  return { code: r.code ?? 1, json: JSON.parse(r.stdout) };
}

describe("GitHub Action", () => {
  it("installs the CLI version this repo is at by default", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
    expect(inputDefault("version")).toBe(pkg.version);
    expect(inputDefault("policy")).toBe(".agent-fence.toml");
    expect(actionYml).toMatch(/branding:\n  icon: shield\n  color: blue/);
  });

  it("the sample policy used by CI passes with no shadowed rules", () => {
    const { code, json } = cliJson("examples/policy/.agent-fence.toml");
    expect(code).toBe(0);
    expect(json).toMatchObject({ failed: 0, shadowed: [], untested: [] });
    expect(json.passed).toBeGreaterThan(3);
    const md = renderMarkdown(json, { policy: "examples/policy/.agent-fence.toml", exitCode: code });
    expect(md).toMatch(/^Passed: .*\*\*5 passed, 0 failed\*\*/m);
    expect(md).not.toMatch(/Failed tests|Shadowed rules/);
    expect(md).toContain("<code>cd infra &amp;&amp; terraform apply -auto-approve</code>");
  });

  it("the failing fixture reports the failure and the shadowed rule", () => {
    const { code, json } = cliJson("test/fixtures/action-failing/.agent-fence.toml");
    expect(code).toBe(1);
    const md = renderMarkdown(json, { policy: "p.toml", exitCode: code });
    expect(md).toMatch(/^Failed: .*\*\*1 passed, 1 failed\*\*, 1 shadowed rule/m);
    expect(md).toMatch(/\| pushes are allowed<br>bash <code>git push origin main<\/code> \| allow \| ask \(<code>git-push<\/code>\) \|/);
    expect(md).toMatch(/\| <code>allow-push<\/code> \(project, allow\) \| bash <code>git push<\/code> \| <code>git-push<\/code> \(built-in, ask\) \|/);
    expect(md).toMatch(/set `fail-on-shadowed: true`/);
    const log = renderLog(json, { policy: "p.toml", exitCode: code });
    expect(log).toContain("FAIL  pushes are allowed: expected allow, got ask (git-push)");
    expect(log.some((l) => l.startsWith("::error ") && l.includes("title=agent-fence test failed::"))).toBe(true);
    expect(log.some((l) => l.startsWith("::warning ") && l.includes("allow-push"))).toBe(true);
    expect(renderLog(json, { policy: "p.toml", exitCode: 1, strict: true }).some((l) => l.startsWith("::error ") && l.includes("shadowed"))).toBe(true);
  });

  it("escapes table cells and explains a policy that could not be loaded", () => {
    const md = renderMarkdown(
      {
        version: "0.2.0", rules: 0, passed: 0, failed: 1, shadowed: [], untested: [], notChecked: [],
        tests: [{ name: 'bash "a | b"', tool: "bash", subject: "a | b", expect: "allow", expectRule: null, pass: false, action: "ask", rule: "x<y>", error: null, file: "f" }],
      },
      { policy: "p", exitCode: 1 },
    );
    expect(md).toContain("<code>a &#124; b</code>");
    expect(md).toContain("<code>x&lt;y&gt;</code>");
    const bad = renderMarkdown(null, { policy: "p", exitCode: 1, stderr: "agent-fence: Unknown option `--policy`" });
    expect(bad).toMatch(/could not be checked/);
    expect(bad).toMatch(/set the `version` input to 0\.2\.0 or newer/);
    expect(renderLog({ error: "p: policy file not found" }, { policy: "p", exitCode: 1 })[0]).toBe("::error title=agent-fence::p: policy file not found");
  });
});
