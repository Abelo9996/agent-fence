---
description: Explain an agent-fence rule, or the most recent block or approval prompt in this project
argument-hint: "[rule-id]"
disable-model-invocation: true
allowed-tools: Bash(agent-fence *) Bash(npx -y @abelo9996/agent-fence *)
---

The user ran `/agent-fence:explain`. Arguments: "$ARGUMENTS"

Run agent-fence as `agent-fence` if that command exists on PATH, otherwise as
`npx -y @abelo9996/agent-fence`. Run it from the project directory.

1. If the arguments name a rule id, run `agent-fence explain <rule-id>`.
2. With no arguments, find the latest decision that was not an allow:
   `agent-fence log --json -n 50`, then take the last line whose `action` is `deny`
   or `ask`. If there is none, say that nothing was blocked or held in this project
   recently and stop. Otherwise run `agent-fence explain <rule>` for its `rule`.
3. Explain in plain words: what the rule matches, which layer it comes from
   (built-in, user or project policy file, with the path), what action it takes, and
   for step 2 the exact input that triggered it and when.
4. If the user may want a different outcome, describe the options: run the command
   themselves, approve it when prompted, or change the policy. Show the exact TOML
   you would add (with a `[[tests]]` case) but do not edit `.agent-fence.toml` or the
   user policy yourself. Rules marked locked cannot be overridden.

Do not retry the blocked action with a different spelling.
