# Changelog

## 0.1.0 (2026-10-03)

First release.

- Policy file `.agent-fence.toml`, merged with a user policy and built-in defaults. Rules have an id, an action (allow, ask, deny), one matcher (command pattern, command regex, path glob, outside the project, secret-looking strings, URL, dynamic program name) and a reason. Most specific match wins; deny wins ties; a project policy cannot loosen the user policy.
- Shell parser that splits chains, pipes, subshells, substitutions, `sh -c` scripts, `eval`, env prefixes and wrappers such as `sudo`, `env`, `xargs` and `find -exec`, and checks file arguments and redirection targets against path rules.
- `check`, `init`, `rules`, `explain`, `test`, `log`, `hooks`, `codex-rules`, `exec` and `shell` commands, plus the `agent-fence-shell` binary.
- Claude Code PreToolUse hook (deny and ask) and Codex PreToolUse hook (deny; ask becomes deny), with settings merged and backed up.
- Codex exec-policy export (`prefix_rule`) for command rules made of literal words.
- JSONL audit log with credential redaction.
- Agent Skill in `skills/agent-fence`.
