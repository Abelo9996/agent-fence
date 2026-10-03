---
name: agent-fence
description: How to respond when agent-fence blocks or holds a tool call. Use this whenever a tool call, hook result or command output contains "agent-fence", "blocked by rule", "needs the user's approval", or exits with code 126 from agent-fence exec / agent-fence-shell, and whenever the user asks you to check, explain, test or change their agent-fence policy (.agent-fence.toml). Also use it before running a command you suspect the policy forbids (force-push, recursive delete, reading .env or ~/.ssh, package installs, writes outside the project).
---

# agent-fence

agent-fence is the user's permission policy for coding agents. It checks shell
commands, file reads and writes, and fetches against rules the user chose, and
writes every decision to an audit log the user reads. A block is the user
speaking in advance, not an obstacle to route around.

## Reading a decision

A blocked or held call comes back with a line like:

```
agent-fence: blocked by rule "git-force-push" [git push --force origin main]. Force-pushing rewrites history ...
```

- **blocked** (deny): the policy forbids this. Do not run it.
- **needs the user's approval** (ask): the user wants to decide. In Claude Code they
  see a prompt. In Codex, and in `agent-fence exec` without a terminal, ask
  is shown as a block because there is no way to prompt.
- The text in brackets is the exact part of the input that matched (one command
  out of a chain, or a resolved path). The rule id tells the user where to look.

## What to do

1. Stop and tell the user what you were trying to do, which rule stopped it, and
   why you needed it. Quote the rule id.
2. Offer options: they run the command themselves, they approve it, or you find
   an approach that stays inside the policy and still meets the goal (for
   example, ask the user for the one value you needed instead of reading `.env`).
3. Wait for an answer before retrying.

Do not try an equivalent command that the rule did not happen to match: a
different flag spelling, `bash -c`, a script file, `eval`, an alias, copying
the file first, or editing through another tool. The audit log records each
attempt, and working around a rule breaks the trust that lets the user give
agents more freedom. Do not edit `.agent-fence.toml`, the user policy, or the
agent's hook settings to loosen a rule; those writes are blocked and logged too.
If you think a rule is wrong, say so and show the change you would make.

## Useful commands

Run as `agent-fence` if it is on PATH, otherwise `npx -y @abelo9996/agent-fence`.

```bash
agent-fence check --tool bash --input "git push origin main"   # exit 0 allow, 2 ask, 3 deny
agent-fence check --tool read --path .env
agent-fence explain git-force-push    # where a rule comes from and what it matches
agent-fence rules                     # every effective rule
agent-fence log --action deny         # what was blocked recently
agent-fence test                      # run the policy's own [[tests]]
```

Checking a command before you run it is cheap and saves a blocked call.

## Changing the policy (only when the user asks)

Show the user the exact TOML you propose and let them apply it, or apply it only
after an explicit yes. Add a `[[tests]]` entry for the case that prompted the
change and run `agent-fence test`. Rules need an `id`, an `action` (allow, ask,
deny), one matcher (`command`, `path`, `outside_project`, `secrets`, `url`) and a
`reason` written for the agent that will read it.

## Undo is a separate tool

agent-fence prevents; it does not roll back. If something already went wrong,
[snap-back](https://github.com/Abelo9996/snap-back) restores the working tree
from its snapshots.
