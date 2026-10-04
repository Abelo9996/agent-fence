/**
 * The built-in policy. It is parsed exactly like a user or project file, so
 * `agent-fence explain <id>` and `agent-fence rules` show these too. Rules with
 * `locked = true` can be changed by the user policy but not by a project policy.
 */
export const BUILTIN_POLICY = String.raw`
version = 1

[defaults]
bash = "allow"
read = "allow"
write = "allow"
fetch = "allow"
unparsable = "ask"

# ---------- git ----------

[[rules]]
id = "git-force-push"
action = "deny"
command = ["git push --force", "git push -f", "git push --force-with-lease", "git push --mirror", "git push +*"]
reason = "Force-pushing rewrites history other people may have pulled. Ask the user to run it themselves if it is really needed."

[[rules]]
id = "git-push"
action = "ask"
command = "git push"
reason = "Pushing publishes commits to a shared remote. Confirm with the user first."

[[rules]]
id = "git-discard-work"
action = "ask"
command = [
  "git reset --hard", "git clean -f", "git checkout -- .", "git checkout .", "git restore .", "git stash drop", "git stash clear", "git branch -D",
  "git filter-branch", "git filter-repo", "git update-ref -d", "git reflog expire",
]
reason = "This discards uncommitted or unmerged work and cannot be undone with git. Confirm with the user first (snap-back can checkpoint the tree)."

[[rules]]
id = "git-rewrite-config"
action = "ask"
command = [
  "git config --global", "git config --system", "git remote set-url", "git remote add",
  "git config {alias.*,core.pager,core.editor,core.sshCommand,core.fsmonitor,core.hooksPath,diff.external,credential.helper,sequence.editor,gpg.program,filter.*}",
  "git -c {alias.*,core.pager=*,core.editor=*,core.sshCommand=*,core.fsmonitor=*,core.hooksPath=*,diff.external=*,credential.helper=*,sequence.editor=*,gpg.program=*,filter.*}",
]
reason = "This changes git configuration, makes git run another command, or changes where code is pushed. Confirm with the user first."

# ---------- destructive shell ----------

[[rules]]
id = "rm-root-or-home"
action = "deny"
command = "rm {-r,-R,--recursive} {/,/\\*,~,~/\\*,..,../\\*}"
reason = "Recursive delete of the filesystem root, the home directory, the project itself or a directory above it. Delete specific subdirectories instead, or ask the user."

[[rules]]
id = "disk-tools"
action = "deny"
command = ["mkfs*", "dd of=/dev/*", "diskutil eraseDisk", "diskutil eraseVolume", "format", "shred"]
reason = "Low-level disk tools can destroy data outside the project."

[[rules]]
id = "sudo"
action = "ask"
command = ["sudo", "doas", "su"]
reason = "Runs with elevated privileges. Confirm with the user first."

[[rules]]
id = "pipe-to-shell"
action = "ask"
command = ["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]
piped_input = true
reason = "Piping text into a shell runs code nobody reviewed (for example curl ... | sh). Download to a file and show it to the user first."

[[rules]]
id = "pipe-to-interpreter"
action = "ask"
command_regex = '^(\S*/)?(python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)( +-[A-Za-z]*)*( +-)?$'
piped_input = true
reason = "Piping text into an interpreter with no script runs code nobody reviewed (for example curl ... | python3). Download to a file and show it to the user first."

[[rules]]
id = "dynamic-command"
action = "ask"
dynamic = true
reason = "The program name comes from a variable or substitution, so the policy cannot see what will run."

# ---------- installs and network ----------

[[rules]]
id = "package-install"
action = "ask"
command = [
  "npm {install,i,add,ci,uninstall,update}", "pnpm {install,i,add,remove,update}", "yarn {add,install,remove,upgrade}", "bun {install,i,add,remove}",
  "pip install", "pip3 install", "pip uninstall", "python* -m pip {install,uninstall}", "uv pip install", "uv add", "pipx install", "poetry add", "conda install",
  "gem install", "cargo install", "cargo add", "go install", "go get",
  "brew install", "brew uninstall", "apt install", "apt-get install", "dnf install", "yum install", "pacman -S", "apk add", "winget install", "choco install", "scoop install",
]
reason = "Installs or removes packages, which downloads and can run third-party code. Confirm the package name with the user first."

[[rules]]
id = "install-from-lockfile"
action = "allow"
command_regex = '^(\S*/)?((npm|pnpm|bun) (install|i|ci)|yarn( install)?|pip3? install( +-r +\S+| +-e +\.\S*| +\.)+|poetry install|uv sync|bundle install)( +--?[A-Za-z][-A-Za-z0-9]*(=\S*)?)*$'
reason = "Installs the dependencies the project already declares (no new package names). Lifecycle scripts still run, as they would for the user."

[[rules]]
id = "publish-or-delete"
action = "deny"
command = ["npm publish", "pnpm publish", "yarn publish", "cargo publish", "twine upload", "gem push", "gh release create", "gh repo delete", "gh repo edit --visibility*"]
reason = "Publishing or changing visibility is public and hard to take back. Ask the user to do it."

# ---------- secrets ----------

[[rules]]
id = "secret-files"
action = "deny"
path = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*",
  "**/.netrc", "**/.npmrc", "**/.pypirc", "**/.git-credentials", "**/credentials.json", "**/service-account*.json",
  "**/.pgpass", "**/.htpasswd",
  "~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.docker/config.json", "~/.config/gh/**", "~/.config/gcloud/**", "~/.azure/**",
  "~/.*_history", "~/.local/share/fish/fish_history", "~/Library/Keychains/**", "~/.password-store/**", "~/.terraform.d/credentials.tfrc.json",
]
reason = "This file usually holds credentials. Ask the user for the specific value you need instead of reading it."

[[rules]]
id = "secret-files-write"
action = "ask"
tool = "write"
path = ["./**/.env", "./**/.env.*"]
reason = "This writes an env file inside the project, which may replace credentials the user keeps there. Confirm with the user first."

[[rules]]
id = "env-examples"
action = "allow"
path = ["**/.env.example", "**/.env.sample", "**/.env.template", "**/.env.defaults"]
reason = "Example env files are meant to be read and committed."

[[rules]]
id = "secret-in-input"
action = "ask"
secrets = true
reason = "This contains what looks like a credential. Make sure the user wants it used here; prefer an environment variable."

# ---------- writes ----------

[[rules]]
id = "write-outside-project"
action = "deny"
tool = "write"
outside_project = true
priority = -100
reason = "Writes outside the project directory are blocked. Ask the user, or work inside the project."

[[rules]]
id = "write-temp"
action = "allow"
tool = "write"
priority = -50
path = ["/tmp/**", "/private/tmp/**", "/var/folders/**", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/*"]
reason = "Temporary files and standard streams."

[[rules]]
id = "protect-fence"
action = "deny"
tool = "write"
locked = true
path = [
  "**/.agent-fence.toml", "**/agent-fence/policy.toml", "**/.claude", "**/.claude/settings.json", "**/.claude/settings.local.json",
  "**/.codex", "**/.codex/hooks.json", "**/.codex/config.toml", "**/.codex/rules", "**/.codex/rules/**", "**/.git/hooks", "**/.git/hooks/**", "**/.git/config",
]
reason = "Agents may not change their own permission policy or hook configuration. Show the user the change you want instead."

[[rules]]
id = "protect-fence-cli"
action = "deny"
locked = true
command = ["agent-fence hooks uninstall", "agent-fence hooks install --command*", "agent-fence init --force", "agent-fence init -f"]
reason = "Agents may not turn off their own permission policy."
`;

/** The commented starter written by `agent-fence init`. */
export const STARTER_POLICY = String.raw`# agent-fence policy for this project.
# Docs: https://github.com/Abelo9996/agent-fence#policy-reference
#
# This file is merged with your user policy and the built-in defaults
# (run "agent-fence rules" to see every effective rule).
#
# How a decision is made:
#   1. Every rule whose matcher matches is a candidate.
#   2. The most specific candidate wins (more literal characters in the
#      pattern = more specific; "priority" adds to that).
#   3. On a tie, deny beats ask beats allow.
#   4. A shell command is split into its simple commands (&&, ;, |, $( ),
#      sh -c "...", sudo, env, xargs, ...); the strictest result wins.
#   5. If nothing matches, the [defaults] action for that tool applies.

version = 1

# Turn off built-in rules by id:
# disable = ["package-install"]

# [defaults]
# bash = "allow"
# read = "allow"
# write = "allow"
# fetch = "allow"
# unparsable = "ask"   # shell input that cannot be parsed

# Shell commands. Words starting with "-" may appear anywhere; "-f" also
# matches inside "-rf". Other words must appear in order.
[[rules]]
id = "no-prod-deploy"
action = "deny"
command = ["npm run deploy:prod", "terraform apply", "kubectl * --context prod*"]
reason = "Production deploys go through CI. Ask the user."

# [[rules]]
# id = "allow-local-installs"
# action = "allow"
# command = "npm install"
# reason = "This project installs from the lockfile only."

# File paths: ** crosses directories, relative patterns are relative to the
# project root, ~/ is your home directory.
# [[rules]]
# id = "no-migrations"
# action = "ask"
# tool = "write"
# path = ["db/migrations/**"]
# reason = "Migrations are reviewed by a human before they are written."

# [[rules]]
# id = "no-network"
# action = "ask"
# command = ["curl", "wget", "nc", "ssh", "scp", "rsync"]
# reason = "Network access needs approval in this repo."

# Policy tests: run "agent-fence test".
[[tests]]
tool = "bash"
input = "cd app && git push --force origin main"
expect = "deny"

[[tests]]
tool = "read"
path = ".env"
expect = "deny"

[[tests]]
tool = "bash"
input = "npm test"
expect = "allow"
`;
