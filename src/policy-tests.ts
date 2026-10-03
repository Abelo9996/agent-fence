import path from "node:path";
import { evaluate, type Decision } from "./engine.js";
import type { Policy, PolicyTest } from "./policy.js";

export interface TestOutcome {
  test: PolicyTest;
  decision?: Decision;
  pass: boolean;
  error?: string;
}

export function describeTest(t: PolicyTest): string {
  const what = t.tool === "bash" ? t.input : t.tool === "fetch" ? t.url : t.path;
  return t.name ?? `${t.tool} ${JSON.stringify(what)}`;
}

/** Run the [[tests]] declared in the user and project policy files. */
export function runPolicyTests(policy: Policy): TestOutcome[] {
  return policy.tests.map((t) => {
    try {
      const decision = evaluate(policy, {
        tool: t.tool,
        command: t.input,
        path: t.path,
        content: t.content,
        url: t.url,
        cwd: t.cwd ? path.resolve(policy.root, t.cwd) : policy.root,
      });
      const pass = decision.action === t.expect && (!t.rule || decision.rule === t.rule);
      return { test: t, decision, pass };
    } catch (e) {
      return { test: t, pass: false, error: (e as Error).message };
    }
  });
}
