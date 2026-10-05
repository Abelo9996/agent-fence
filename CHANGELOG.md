# Changelog

## 0.2.0 (unreleased)

GitHub Action and policy linting.

- The repository is a GitHub Action (`uses: Abelo9996/agent-fence@v0`). It runs `agent-fence test` on a policy file, writes a job summary with passes, failures and shadowed rules, adds annotations on the policy file, sets outputs (`result`, `passed`, `failed`, `shadowed`, `untested`, `report-path`) and fails the job when a test fails. `fail-on-shadowed: true` also fails it on shadowed rules. See "Use in CI" in the README and `examples/agent-fence-policy.yml`.
- New `agent-fence lint`: reports shadowed rules (a user or project rule that never decides anything, because for the smallest input its own pattern matches another rule wins) with the winning rule and why, and rules that no `[[tests]]` case is decided by. Exit 1 when a rule is shadowed.
- `agent-fence test` warns about shadowed rules after the results; `--strict` makes them fail. `--json` prints the results, shadowed rules and untested rules as JSON (a policy error becomes `{"error": ...}`).
- New global `--policy <file>`: load that file as the project policy instead of `.agent-fence.toml`, with the project root set to its directory.
- Claude Code plugin: `/plugin marketplace add Abelo9996/open-agent-lab`, then `/plugin install agent-fence@open-agent-lab`. It ships the skill, the `PreToolUse` hook (through `hooks/hooks.json`, so no settings file is edited), `/agent-fence:explain` (with no rule id it explains the latest block or approval prompt) and `/agent-fence:log`. The hook uses a global install when one is on PATH and otherwise runs through `npx`.
- Codex plugin: `.codex-plugin/plugin.json` with the skill, an icon and a `PreToolUse` hook (`npx -y @abelo9996/agent-fence hook codex`), installable with `codex plugin add agent-fence@open-agent-lab`.
- Audit log entries written through a plugin's hook carry `"plugin": true`, and `agent-fence hooks status` shows when the Claude Code or Codex plugin last checked a call.
- `protect-fence-cli` also denies `claude plugin disable|uninstall|remove agent-fence...` and `codex plugin remove agent-fence...`, so an agent cannot turn off the plugin that checks it.

## 0.1.1 (2026-10-04)

Fixes from a first-user review: fewer false blocks in normal work, and several ways around the built-in rules closed.

Fewer false blocks:

- `npm install`, `npm ci`, `pnpm install`, `yarn`, `pip install -r requirements.txt`, `pip install -e .`, `uv sync`, `poetry install` and `bundle install` (no new package names) are allowed by the new `install-from-lockfile` rule. Adding a named package still asks.
- Commands that only look at file names no longer count as reading them: `echo .env >> .gitignore`, `ls -la .env`, `test -f .env`, `stat .env`, `git check-ignore .env`, `git rm --cached .env` are allowed.
- Writing an env file inside the project (`cp .env.example .env`) asks instead of being denied (new `secret-files-write` rule). Reading it is still denied.
- The destination of `cp`, `ln`, `install`, `rsync` and `scp` is no longer also checked as a read.

Closed bypasses:

- Heredocs and here-strings given to a shell (`bash <<EOF`, `sh <<< "..."`), `alias` definitions, variables assigned earlier in the same input (`x=git; $x push -f`) and `$IFS` word splitting.
- Package runners: `npx`, `npx -c`, `npm exec`, `pnpm exec/dlx`, `yarn dlx`, `bunx`, `uv run`, `uvx`, `poetry run`, `pipenv run`, `bundle exec`, `pipx run` (for example `npx npm publish`).
- `bash <(curl ...)`, `source <(curl ...)` and `curl ... | python3` (or node, perl, ruby, php) now ask (`pipe-to-interpreter`).
- Globs and `{a,b}` in arguments are expanded before path checks (`cat .e*v`, `cat ~/.s*/id_*`).
- `curl -d @file`, `--data-binary @file` and `-F name=@file` uploads are checked as reads.
- `find -delete` (and `find -exec rm`), `mv` sources, `tar -x -C dir`, `tar -P`, `unzip -d dir` and `cp/mv -t dir` are checked as writes.
- A recursive delete of the project itself or a directory above it (`cd .. && rm -rf proj`, `rm -rf .` in the root) is denied by `rm-root-or-home`; `rm -rf .git` asks.
- `python3 -m pip install`, `git checkout .`, `git filter-branch`, `git filter-repo`, `git update-ref -d`, `git reflog expire`, and git config that makes git run another command (`git -c alias.*`, `core.pager`, `core.fsmonitor`, `core.hooksPath`, `core.sshCommand` and similar) now ask.
- `protect-fence` also covers deleting or moving `.claude`, `.codex` and `.git/hooks`, writing `.git/config`, and `agent-fence hooks install --command`.
- `secret-files` also covers shell history files, the macOS keychain directory, `.pgpass`, `.htpasswd`, `pass` and Terraform credentials.

Clearer output:

- Deny and ask messages end with how the user can change the decision (`agent-fence explain <rule>`); `check` prints the same as a `change:` line, and `explain` prints the exact TOML to turn a rule off or allow one case.
- `hooks status --agent codex` says whether Codex has recorded trust for the hook, and `hooks install --agent codex` explains the "Hooks need review" prompt. Codex reasons no longer end in "..".
- `log` explains an empty log and points at `explain` and `--json`.
- Piping output into `head` no longer prints an EPIPE stack trace.

## 0.1.0 (2026-10-03)

First release.

- Policy file `.agent-fence.toml`, merged with a user policy and built-in defaults. Rules have an id, an action (allow, ask, deny), one matcher (command pattern, command regex, path glob, outside the project, secret-looking strings, URL, dynamic program name) and a reason. Most specific match wins; deny wins ties; a project policy cannot loosen the user policy.
- Shell parser that splits chains, pipes, subshells, substitutions, `sh -c` scripts, `eval`, env prefixes and wrappers such as `sudo`, `env`, `xargs` and `find -exec`, and checks file arguments and redirection targets against path rules.
- `check`, `init`, `rules`, `explain`, `test`, `log`, `hooks`, `codex-rules`, `exec` and `shell` commands, plus the `agent-fence-shell` binary.
- Claude Code PreToolUse hook (deny and ask) and Codex PreToolUse hook (deny; ask becomes deny), with settings merged and backed up.
- Codex exec-policy export (`prefix_rule`) for command rules made of literal words.
- JSONL audit log with credential redaction.
- Agent Skill in `skills/agent-fence`.
