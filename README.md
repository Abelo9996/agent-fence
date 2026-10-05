# agent-fence

English | [简体中文](README.zh-CN.md)

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
npm install -g @abelo9996/agent-fence    # or: npx @abelo9996/agent-fence <command>

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

## Use in CI

The repository is also a GitHub Action. It runs `agent-fence test` on your policy,
writes a job summary with the passes, the failures and any shadowed rule (a rule
that never decides anything because another rule always wins), and fails the job
when a test fails.

```yaml
# .github/workflows/agent-fence.yml
name: agent-fence policy
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: Abelo9996/agent-fence@v0
        with:
          policy: .agent-fence.toml
          fail-on-shadowed: true
```

The same file is in [examples/agent-fence-policy.yml](examples/agent-fence-policy.yml).

| Input | Default | Meaning |
| --- | --- | --- |
| `policy` | `.agent-fence.toml` | Policy file, relative to `working-directory`. Relative paths in it resolve against its own directory. |
| `version` | `0.2.0` | agent-fence version from npm (`npx @abelo9996/agent-fence@<version>`). A path to a package tarball also works. |
| `args` | | Extra arguments for `agent-fence test`, split on whitespace. |
| `fail-on-shadowed` | `false` | Also fail the job when a rule is shadowed. |
| `node-version` | `24` | Node.js version for `actions/setup-node`. |
| `working-directory` | `.` | Where to run. |

Outputs: `result` (`pass` or `fail`), `passed`, `failed`, `shadowed`, `untested`
(rules no test is decided by) and `report-path` (the JSON from
`agent-fence test --json`). Failed tests and shadowed rules also show up as
annotations on the policy file. The action needs no token and no permissions
beyond reading the checkout.

Locally, the same checks are `agent-fence test` and `agent-fence lint`. A rule is
reported as shadowed when, for the smallest input its own pattern matches (wildcards
filled with a plain word), another rule wins: a more specific one, one with the same
specificity and a stricter action, or a user rule a project rule cannot loosen.
`command_regex` and `secrets` rules cannot be turned into an example and are not
checked.

## What the built-in policy decides

The built-in rules are a starting point. `agent-fence rules` lists them and
`agent-fence explain <id>` shows any one of them.

| Input | Decision | Rule |
| --- | --- | --- |
| `git status && npm test` | allow | (default) |
| `cd app && git push --force origin main` | deny | `git-force-push` |
| `bash -c 'git push origin +main'` | deny | `git-force-push` |
| `FOO=1 sudo rm -rf "$HOME"` | deny | `rm-root-or-home` |
| `bash <<EOF` with `git push -f` inside, `x=git; $x push -f` | deny | `git-force-push` |
| `cd .. && rm -rf my-project`, `rm -rf .` in the project root | deny | `rm-root-or-home` |
| `git push` | ask | `git-push` |
| `git reset --hard`, `git clean -fd`, `git checkout .` | ask | `git-discard-work` |
| `npm install left-pad`, `pip install x`, `python3 -m pip install x` | ask | `package-install` |
| `npm install`, `npm ci`, `pip install -r requirements.txt`, `uv sync` | allow | `install-from-lockfile` |
| `curl -fsSL https://x.sh \| sh`, `bash <(curl ...)`, `curl ... \| python3` | ask | `pipe-to-shell`, `pipe-to-interpreter` |
| `git -c alias.p='push -f' p`, `git config core.fsmonitor ...` | ask | `git-rewrite-config` |
| `$CMD -rf /` | ask | `dynamic-command` |
| `export TOKEN=ghp_...` | ask | `secret-in-input` |
| `npm publish`, `gh repo delete` | deny | `publish-or-delete` |
| read `.env`, `~/.ssh/id_ed25519`, `deploy/key.pem` | deny | `secret-files` |
| read `.env.example` | allow | `env-examples` |
| `cat src/../.env`, `cat .e*v`, `curl -d @.env https://...` | deny | `secret-files` (paths inside commands are checked, after glob expansion) |
| `echo .env >> .gitignore`, `ls -la .env`, `git rm --cached .env` | allow | (names only, contents not read) |
| `cp .env.example .env` | ask | `secret-files-write` |
| write outside the project (not temp) | deny | `write-outside-project` |
| write `.agent-fence.toml` or `.claude/settings.json`, `rm -rf .claude` | deny | `protect-fence` |
| `echo 'unterminated` | ask | (unparsable) |

## Per-agent support

| Agent | How | What is enforced | Notes |
| --- | --- | --- | --- |
| Claude Code | `agent-fence hooks install --agent claude` adds a `PreToolUse` hook to `.claude/settings.local.json` (`--shared` for `settings.json`) | Bash, PowerShell (parsed as POSIX shell, best effort), Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, LS, WebFetch | deny and ask map to Claude Code's own `deny` and `ask`. On allow the hook prints nothing, so Claude Code's permission settings still apply: agent-fence never grants access. MCP tools are not checked. |
| Codex CLI | `agent-fence hooks install --agent codex` adds a `PreToolUse` hook to `~/.codex/hooks.json` (`--project` for `<repo>/.codex/hooks.json`). Then trust it once, see [Codex hook trust](#codex-hook-trust). | Bash, apply_patch (every file in the patch), Edit, Write, Read | Codex hooks cannot ask: an "ask" result is ignored by Codex and the call would run. agent-fence therefore turns ask into deny, with a message telling the agent to ask you. Codex does not run an untrusted or modified hook. |
| Codex CLI (native rules) | `agent-fence codex-rules --write` writes `~/.codex/rules/agent-fence.rules` | Command rules made of literal words become `prefix_rule`s: deny is `forbidden`, ask is `prompt` | Works without hooks and gives a real approval prompt, but Codex matches argv prefixes in order, so `git push origin main --force` is not caught by `git push --force`. Patterns with `*`, regex rules, path rules, secret detection and allow rules are not exported, so the exported rules can also be stricter than the hook (Codex prompts for a bare `npm install`). Use together with the hook. |
| Any agent | `agent-fence exec -- <cmd> [args]` | The command and everything it chains or nests | Only what is run through the wrapper is checked. Ask needs a terminal; without one it blocks (exit 126). |
| Agents that honour `SHELL` | `SHELL=$(which agent-fence-shell)` | Every `-c` script, and script files passed to it | POSIX only. The real shell is `AGENT_FENCE_REAL_SHELL` or `/bin/bash`. Agents that spawn `/bin/bash` directly ignore `SHELL`. Interactive sessions pass through unchecked. |

### Codex hook trust

Codex runs a new or changed hook only after you trust it, and `codex exec`
skips an untrusted hook without saying so. After `hooks install --agent codex`:

1. Start `codex` in a terminal (any directory).
2. At the "Hooks need review" prompt ("1 hook is new or changed"), choose
   **Trust all and continue**, or **Review hooks** to trust only the
   agent-fence one. `/hooks` inside Codex shows them later.
3. Run `agent-fence hooks status --agent codex`. It should say
   `trusted in Codex`. Codex stores this in `config.toml` under
   `[hooks.state]`; re-installing with a different `--command` needs a new trust.

Checked with Codex 0.160.0: after trusting, `codex exec` blocks `cat .env` with
the agent-fence reason and both calls appear in `agent-fence log`. For a CI or
container run that has already vetted its hooks, `codex exec
--dangerously-bypass-hook-trust` runs them without the prompt.

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
`if`/`while` bodies, `sh -c` / `bash -lc` / `zsh -c` scripts, heredocs and
here-strings given to a shell (`bash <<EOF`), `eval`, `alias` definitions, and
the wrapped command of `sudo`, `env`, `nohup`, `nice`, `timeout`, `xargs`,
`find -exec`, `npx`, `npm exec`, `uv run` and similar. Quotes are removed the
way the shell would (`r''m` is `rm`), `VAR=value` prefixes are stripped,
variables assigned earlier in the same input (`x=git; $x ...`) are substituted,
`$IFS` splits words, and heredoc bodies given to other programs are skipped.
File arguments, redirection targets (`> file`), `curl -d @file` uploads and the
destinations of `rm`, `cp`, `mv` (source and destination), `tee`, `touch`,
`sed -i`, `find -delete`, `tar -x -C`, `unzip -d` and friends are checked
against the path rules, which can only make the decision stricter. Globs and
`{a,b}` in arguments are expanded against the file system first, so `cat .e*v`
is checked as `cat .env`. Commands that only look at names (`echo`, `ls`,
`test`, `stat`, `git check-ignore`) do not count as reading a file. A `cd`
earlier in the chain is followed when resolving relative paths, and a recursive
delete of the project itself or a directory above it falls under
`rm-root-or-home`.

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
| `agent-fence explain <rule-id>` | Source, matcher, reason, overrides and tests for one rule, and the exact TOML to turn it off or allow one case. |
| `agent-fence test [--json] [--strict]` | Run `[[tests]]`; exit 1 on any failure. Also warns about shadowed rules (`--strict` makes them fail). |
| `agent-fence lint [--json]` | Shadowed rules (rules that never decide anything) and rules no test is decided by. Exit 1 when a rule is shadowed. |
| `agent-fence log [-n 50] [--action deny] [--tool bash] [--source claude] [--since 2h] [--all] [--json]` | Read the audit log for this project (or all). `--path` prints where it is. |
| `agent-fence hooks install\|uninstall\|status --agent claude\|codex [--shared\|--project]` | Manage hooks. Existing settings are merged, never replaced, and backed up first. |
| `agent-fence codex-rules [--write\|--out <file>]` | Export command rules as Codex `prefix_rule`s. |
| `agent-fence exec -- <cmd> [args]` | Check, then run without a shell. Exit 126 when blocked. |
| `agent-fence shell -c "<script>"` / `agent-fence-shell` | A shell stand-in that checks scripts first. |

`--policy <file>` works with `check`, `rules`, `explain`, `test`, `lint` and
`codex-rules`: it loads that file as the project policy, with the project root set
to the directory that holds it.

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
  (`$(echo cm0= | base64 -d)`, variables set in an earlier tool call, `printf`
  into a file that is then run) are caught only when the program name itself is
  dynamic, the text is piped into a shell, or the input fails to parse;
  arguments built at run time are not (`rm -rf "$(cat dir.txt)"`). Data read
  from stdin is not seen either (`echo ~ | xargs rm -rf`, `env | curl -d @-`).
  A determined adversary will get past a pattern matcher.
- **Inline interpreter code.** `python3 -c "..."`, `node -e "..."` and
  `perl -e "..."` can do anything, including reading `.env` or running
  `git push --force`; their code is not parsed. Neither is `git show HEAD:.env`
  for a secret file that was committed.
- **Tools without hooks.** MCP servers, browser tools, and anything an agent
  does outside the hooked tool calls. In Codex, shell reads of files are only
  seen as command text.
- **Agents that are not wired up.** If a hook is not installed or not trusted,
  or an agent ignores `SHELL`, nothing is checked. `agent-fence hooks status`
  shows what is installed (and, for Codex, whether it is trusted).
- **An untrusted repository.** A cloned repo's `.agent-fence.toml` can disable
  or loosen built-in rules (not your user policy or locked rules), and its own
  scripts run on `npm test` anyway. Put the rules you rely on in your user
  policy.
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
