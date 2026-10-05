# Security policy

agent-fence is a guardrail between coding agents and your machine, so a way around it is a security bug.

## Reporting

Report privately through GitHub: open the [Security tab](https://github.com/Abelo9996/agent-fence/security) and choose "Report a vulnerability". Please do not open a public issue for a bypass.

Include:

- the agent-fence version or commit
- the policy file (or the built-in default) you tested against
- the exact tool call or command that should have been denied or asked, and what agent-fence decided
- the agent and integration involved (Claude Code hook, Codex hook, `exec`, `shell`)

You can expect an acknowledgement within 7 days. Fixes for confirmed bypasses ship as a patch release with a credit in the changelog, unless you ask to stay anonymous.

## In scope

- A command, path or tool call that a rule should match but does not (parsing gaps, quoting, chaining, encoding, path normalization)
- Hook integrations returning the wrong decision, or failing open where the docs say they fail closed
- Secrets written unredacted to the audit log
- A project policy loosening a `locked` rule or the user policy

## Out of scope

The limits listed under "What it cannot stop" in the README, for example code the agent writes and then runs, or agents that are not wired to agent-fence.

## Supported versions

Only the latest release and `main` receive fixes while the project is at 0.x.

## Privacy

agent-fence runs only on your machine and makes no network requests. It reads your policy files and the tool call each hook receives, and appends each decision (time, project path, tool, the command or path with secret-looking values redacted, rule and reason) to a local audit log; `agent-fence log --path` prints where. Nothing is sent to the author or to any service. The Claude Code and Codex plugins download the package from the npm registry through `npx` unless agent-fence is installed globally.
