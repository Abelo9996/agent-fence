---
description: Show recent agent-fence decisions (allowed, held and blocked tool calls) for this project
argument-hint: "[--action deny|ask|allow] [--since 2h] [-n 20]"
disable-model-invocation: true
allowed-tools: Bash(agent-fence *) Bash(npx -y @abelo9996/agent-fence *)
---

The user ran `/agent-fence:log`. Arguments: "$ARGUMENTS"

Run agent-fence as `agent-fence` if that command exists on PATH, otherwise as
`npx -y @abelo9996/agent-fence`. From the project directory run
`agent-fence log $ARGUMENTS` (pass the arguments through; with none it shows the
last 20 decisions for this project).

Summarize: how many calls were allowed, held for approval and blocked, then list the
held and blocked ones with time, tool, rule id and the input shown in the log. Keep
inputs exactly as logged (secrets are already redacted). If the log is empty, say so
and mention that decisions are recorded only when a hook, `agent-fence exec` or
`agent-fence-shell` checks a call. For any rule the user asks about, suggest
`/agent-fence:explain <rule-id>`.
