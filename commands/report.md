---
description: One-screen report of what your agents tried (allowed, held and blocked), riskiest blocks first, with an optional shareable card
argument-hint: "[--since 7d] [--all] [--card card.png]"
disable-model-invocation: true
allowed-tools: Bash(agent-fence *) Bash(npx -y @abelo9996/agent-fence *)
---

The user ran `/agent-fence:report`. Arguments: "$ARGUMENTS"

Run agent-fence as `agent-fence` if that command exists on PATH, otherwise as
`npx -y @abelo9996/agent-fence`. From the project directory run
`agent-fence report $ARGUMENTS` (pass the arguments through; with none it covers
this project's whole audit log).

Summarize the output: how many calls were allowed, held for approval and blocked,
then the riskiest blocked or held categories with their counts and rule ids. Keep
any example inputs exactly as printed (secrets and paths are already redacted). If
the user passed `--card`, confirm the PNG and SVG paths and note the card shows
counts only, so it is safe to share. If the report is empty, say so and mention
that decisions are recorded only once a hook, `agent-fence exec` or
`agent-fence-shell` checks a call, and that `agent-fence replay <session-log>` can
audit an existing transcript with nothing installed. For any rule the user asks
about, suggest `/agent-fence:explain <rule-id>`.
