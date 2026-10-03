# Contributing

Thanks for helping. Bug reports, bypass reports and agent integrations are the most useful contributions.

## Setup

```bash
git clone https://github.com/Abelo9996/agent-fence
cd agent-fence
npm install
npm test          # builds, then runs vitest
npm run typecheck
```

Node 20 or newer. Tests create everything in temp directories and point the user policy, home directory and audit log at them through `AGENT_FENCE_CONFIG`, `AGENT_FENCE_HOME_DIR` and `AGENT_FENCE_LOG`, so they never touch your real configuration.

## Where things live

- `src/parse.ts`: the shell parser. It finds every simple command a script could run; it never executes or expands anything.
- `src/match.ts`: command patterns and path globs.
- `src/policy.ts`, `src/defaults.ts`: loading, validation, layering and the built-in policy.
- `src/engine.ts`: turns a request into a decision.
- `src/adapters.ts`, `src/hooks.ts`: agent hook payloads and settings files.
- `src/wrap.ts`: `exec` and the shell wrapper.

## Reporting a bypass

If a command or path gets past a rule that should match it, open a policy bypass report with the exact input, the rule, and what `agent-fence check --json` printed. Add a failing case to `test/engine.test.ts` or `test/parse.test.ts` with the fix if you can.

## Adding an agent

An integration needs a way to see a tool call before it runs and to refuse it. Map the agent's tool names onto `bash`, `read`, `write` and `fetch` requests in `src/adapters.ts`, add synthetic payload tests in `test/hooks.test.ts`, and document in the README exactly what is and is not enforced.

## Style

- Keep dependencies small and free of native code.
- Built-in rules should be uncontroversial and explain themselves in `reason`.
- Plain, specific wording in docs and messages.
