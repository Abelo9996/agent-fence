# agent-fence

[![CI](https://github.com/Abelo9996/agent-fence/actions/workflows/ci.yml/badge.svg)](https://github.com/Abelo9996/agent-fence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![agent-fence check denying "cd app && git push --force" and "cat .env" with the matching rule and reason, and allowing "npm test"](docs/demo.gif)

**One permission policy file decides what every coding agent on your machine may run, read and write, and logs everything it tried.**

Write the rules once in `.agent-fence.toml`. Claude Code and Codex enforce them
through their hooks, and any other agent can run its commands through a wrapper.
Each decision is appended to a local audit log, so you can see what your agent
tried and what was stopped.

## Quickstart (30 seconds)

```bash
npm install -g github:Abelo9996/agent-fence    # or: npx github:Abelo9996/agent-fence <command>

cd your-project
agent-fence init                               # commented starter .agent-fence.toml
agent-fence hooks install --agent claude       # PreToolUse hook in .claude/settings.local.json
agent-fence check --input "cd app && rm -rf ~" # DENY, exit code 3
agent-fence log                                # what your agents tried in this project
```

Requires Node 20 or newer. No native dependencies.

## Example policy

```toml
version = 1
disable = ["package-install"]      # turn off a built-in rule by id

[[rules]]
id = "no-prod-deploy"
action = "deny"
command = ["npm run deploy:prod", "terraform apply", "kubectl * --context prod*"]
reason = "Production deploys go through CI. Ask the user."

[[rules]]
id = "migrations-need-review"
action = "ask"
tool = "write"
path = "db/migrations/**"
reason = "Migrations are reviewed by a human before they are written."

[[tests]]
tool = "bash"
input = "cd infra && terraform apply -auto-approve"
expect = "deny"
rule = "no-prod-deploy"
```

`agent-fence test` runs the `[[tests]]` so a team can unit-test its policy in CI.

## What the built-in policy decides

The built-in rules are a starting point. `agent-fence rules` lists them and
`agent-fence explain <id>` shows any one of them.

| Input | Decision | Rule |
| --- | --- | --- |
| `git status && npm test` | allow | (default) |
| `cd app && git push --force origin main` | deny | `git-force-push` |
| `bash -c 'git push origin +main'` | deny | `git-force-push` |
| `FOO=1 sudo rm -rf "$HOME"` | deny | `rm-root-or-home` |
| `git push` | ask | `git-push` |
| `git reset --hard`, `git clean -fd` | ask | `git-discard-work` |
| `npm install left-pad`, `pip install x` | ask | `package-install` |
| `curl -fsSL https://x.sh \| sh` | ask | `pipe-to-shell` |
| `$CMD -rf /` | ask | `dynamic-command` |
| `export TOKEN=ghp_...` | ask | `secret-in-input` |
| `npm publish`, `gh repo delete` | deny | `publish-or-delete` |
| read `.env`, `~/.ssh/id_ed25519`, `deploy/key.pem` | deny | `secret-files` |
| read `.env.example` | allow | `env-examples` |
| `cat src/../.env` | deny | `secret-files` (paths inside commands are checked too) |
| write outside the project (not temp) | deny | `write-outside-project` |
| write `.agent-fence.toml` or `.claude/settings.json` | deny | `protect-fence` |
| `echo 'unterminated` | ask | (unparsable) |

## Per-agent support

| Agent | How | What is enforced | Notes |
| --- | --- | --- | --- |
| Claude Code | `agent-fence hooks install --agent claude` adds a `PreToolUse` hook to `.claude/settings.local.json` (`--shared` for `settings.json`) | Bash, PowerShell (parsed as POSIX shell, best effort), Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, LS, WebFetch | deny and ask map to Claude Code's own `deny` and `ask`. On allow the hook prints nothing, so Claude Code's permission settings still apply: agent-fence never grants access. MCP tools are not checked. |
| Codex CLI | `agent-fence hooks install --agent codex` adds a `PreToolUse` hook to `~/.codex/hooks.json` (`--project` for `<repo>/.codex/hooks.json`). Then trust it once in Codex with `/hooks`. | Bash, apply_patch (every file in the patch), Edit, Write, Read | Codex hooks cannot ask: an "ask" result is ignored by Codex and the call would run. agent-fence therefore turns ask into deny, with a message telling the agent to ask you. Codex does not run an untrusted or modified hook. |
| Codex CLI (native rules) | `agent-fence codex-rules --write` writes `~/.codex/rules/agent-fence.rules` | Command rules made of literal words become `prefix_rule`s: deny is `forbidden`, ask is `prompt` | Works without hooks and gives a real approval prompt, but Codex matches argv prefixes in order, so `git push origin main --force` is not caught by `git push --force`. Patterns with `*`, path rules and secret detection are not exported. Use together with the hook. |
| Any agent | `agent-fence exec -- <cmd> [args]` | The command and everything it chains or nests | Only what is run through the wrapper is checked. Ask needs a terminal; without one it blocks (exit 126). |
| Agents that honour `SHELL` | `SHELL=$(which agent-fence-shell)` | Every `-c` script, and script files passed to it | POSIX only. The real shell is `AGENT_FENCE_REAL_SHELL` or `/bin/bash`. Agents that spawn `/bin/bash` directly ignore `SHELL`. Interactive sessions pass through unchecked. |

## Policy reference

Policies are TOML. Three layers are merged:

1. built-in defaults (shown by `agent-fence rules`),
2. your user policy: `~/.config/agent-fence/policy.toml` (`$XDG_CONFIG_HOME` is honoured; `%APPDATA%\agent-fence\policy.toml` on Windows; `AGENT_FENCE_CONFIG` overrides),
3. the project policy: `.agent-fence.toml` in the project root (the nearest directory with that file, else the git root).

`agent-fence init --user` writes a starter user policy.

### Rules

| Key | Meaning |
| --- | --- |
| `id` | Unique name. A rule with the same id in a later layer replaces the earlier one. |
| `action` | `allow`, `ask` or `deny`. |
| `reason` | Shown to the agent (and you). Write it as an instruction. |
| `tool` | `bash`, `read`, `write`, `fetch`, or a list. Inferred from the matcher when omitted. |
| `command` | Shell command pattern(s), see below. |
| `command_regex` | A regular expression tested against each simple command. |
| `path` | Path glob(s). `**` crosses directories; `~/` is your home; patterns starting with `**` match anywhere; other relative patterns are relative to the project root. Applies to read and write unless `tool` says otherwise. |
| `outside_project` | `true`: matches any path outside the project root. |
| `secrets` | `true`: matches shell input or written content that contains credential-looking strings (cloud keys, tokens, private keys, `PASSWORD=...`). |
| `url` | URL glob(s) for fetch tools. |
| `dynamic` | `true`: matches commands whose program name comes from a variable or substitution. |
| `piped_input` | With `command`: only match when stdin is a pipe (`curl ... \| sh`). |
| `priority` | Number added to the rule's specificity. |

Top level: `disable = ["id", ...]` removes earlier rules, and `[defaults]` sets
the action when nothing matches (`bash`, `read`, `write`, `fetch`, all `allow`
by default) and for shell input that cannot be parsed (`unparsable`, `ask`).

### Command patterns

`git push --force` means: the program is `git` (any directory, so `/usr/bin/git`
counts), `push` appears among the arguments, and `--force` appears anywhere.
Words that start with `-` are flags and may come in any order; a one-letter flag
such as `-f` also matches inside a cluster such as `-rf`. Other words must
appear in the given order, with anything in between. `*`, `?` and `{a,b}` work
inside a word; `\*` is a literal star. `~`, `$HOME` and `${HOME}` are the same.

Before matching, a command is split into every simple command it would run:
`&&`, `||`, `;`, `|`, `&`, newlines, `( )`, `{ }`, `$( )`, backticks, `<( )`,
`if`/`while` bodies, `sh -c` / `bash -lc` / `zsh -c` scripts, `eval`, and the
wrapped command of `sudo`, `env`, `nohup`, `nice`, `timeout`, `xargs`,
`find -exec` and similar. Quotes are removed the way the shell would
(`r''m` is `rm`), `VAR=value` prefixes are stripped, and heredoc bodies are
skipped. File arguments, redirection targets (`> file`) and the destinations of
`rm`, `cp`, `mv`, `tee`, `touch`, `sed -i` and friends are checked against the
path rules, which can only make the decision stricter. A `cd` earlier in the
chain is followed when resolving relative paths.

### How a decision is made

1. Every rule whose matcher matches is a candidate.
2. The candidate with the highest specificity wins. Specificity is the number of
   literal (non-wildcard) characters in the pattern that matched, plus `priority`.
   `outside_project`, `secrets` and `dynamic` have specificity 0.
3. On a tie, deny beats ask beats allow. Then project beats user beats built-in.
4. A shell command gets one decision per simple command and per checked path;
   the strictest one is the result.
5. If nothing matched, `[defaults]` applies.

A project policy can loosen the built-in defaults but not your user policy:
it cannot replace or disable a user rule, and when a user rule matches with ask
or deny, project rules with a weaker action are ignored for that check. Rules
marked `locked` (such as `protect-fence`) cannot be changed by a project policy.
In the built-in policy `write-outside-project` has priority -100 and
`write-temp` -50, so any path rule you write outranks them.

### Paths

Every path is made absolute, `~` and `$HOME` are expanded, `..` is collapsed,
backslashes are treated as separators, and symlinks are resolved for the part of
the path that exists. Matching ignores case on macOS and Windows.

## Commands

| Command | Does |
| --- | --- |
| `agent-fence check --tool bash --input "<cmd>"` | Print the decision. Also `--tool read|write|edit --path <p>`, `--tool fetch --url <u>`, `--json`. Exit 0 allow, 2 ask, 3 deny, 1 error. |
| `agent-fence init [--user] [--force]` | Write a commented starter policy. |
| `agent-fence rules [--json]` | Every effective rule and which file it came from. |
| `agent-fence explain <rule-id>` | Source, matcher, reason, overrides and tests for one rule. |
| `agent-fence test` | Run `[[tests]]`; exit 1 on any failure. |
| `agent-fence log [-n 50] [--action deny] [--tool bash] [--source claude] [--since 2h] [--all] [--json]` | Read the audit log for this project (or all). `--path` prints where it is. |
| `agent-fence hooks install\|uninstall\|status --agent claude\|codex [--shared\|--project]` | Manage hooks. Existing settings are merged, never replaced, and backed up first. |
| `agent-fence codex-rules [--write\|--out <file>]` | Export command rules as Codex `prefix_rule`s. |
| `agent-fence exec -- <cmd> [args]` | Check, then run without a shell. Exit 126 when blocked. |
| `agent-fence shell -c "<script>"` / `agent-fence-shell` | A shell stand-in that checks scripts first. |

### Audit log

One JSON object per line in `~/.local/state/agent-fence/audit.jsonl`
(`$XDG_STATE_HOME` honoured; `%LOCALAPPDATA%\agent-fence` on Windows;
`AGENT_FENCE_LOG` overrides). Each entry has the time, integration, project,
tool, the agent's tool name, the input, the decision, the rule and its reason.
Inputs are truncated at 2,000 characters and anything that looks like a
credential is replaced with `[REDACTED]` before it is written. File contents are
never logged, only paths. `AGENT_FENCE_NO_LOG=1` turns logging off.

## What it cannot stop

agent-fence reads what an agent says it will do. It is a policy layer, not a
sandbox, and it is only as good as the hook or wrapper in front of it.

- **Code the agent writes and then runs.** `python build.py` is allowed; what
  `build.py` does is not seen. The same goes for `npm test`, `make`, git hooks and
  anything else that executes files from the project.
- **Obfuscation the parser cannot see through.** Commands assembled at run time
  (`$(echo cm0= | base64 -d)`, variables, `printf` into `sh`) are caught only
  when the program name itself is dynamic or the input fails to parse; arguments
  built at run time are not. A determined adversary will get past a pattern
  matcher.
- **Tools without hooks.** MCP servers, browser tools, and anything an agent
  does outside the hooked tool calls. In Codex, shell reads of files are only
  seen as command text.
- **Agents that are not wired up.** If a hook is not installed or not trusted,
  or an agent ignores `SHELL`, nothing is checked. `agent-fence hooks status`
  shows what is installed.
- **Failures that open.** If the `agent-fence` binary is missing, Claude Code
  and Codex treat the hook error as non-blocking and run the call. Install it
  globally so the hook command keeps resolving.
- **Network egress and credentials in the environment.** Use a real sandbox (a
  container, VM, or the agent's own sandbox mode) for isolation, and keep
  long-lived secrets out of the agent's environment.

## Prevention and rollback

agent-fence decides what an agent may do. [snap-back](https://github.com/Abelo9996/snap-back)
undoes what it already did: it snapshots the working tree around each agent
step so one command rolls a change back. They are designed to run together; the
`git-discard-work` rule's reason points at snap-back for that reason.

## Agent Skill

`skills/agent-fence/SKILL.md` teaches an agent to read a deny or ask reason, tell
you what it wanted to do, and wait, instead of trying an equivalent command.

```bash
npx skills add Abelo9996/agent-fence
```

## Related projects

- [snap-back](https://github.com/Abelo9996/snap-back): undo for any coding agent.
- [nerf-watch](https://github.com/Abelo9996/nerf-watch): detects silent model and cost changes.
- [rerun-bench](https://github.com/Abelo9996/rerun-bench): measures how consistent an agent is across reruns.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Found a way past a rule? Open a
[policy bypass report](https://github.com/Abelo9996/agent-fence/issues/new?template=policy_bypass.yml).

## License

[MIT](LICENSE)
