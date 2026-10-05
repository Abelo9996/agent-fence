# agent-fence

[English](README.md) | 简体中文

[![CI](https://github.com/Abelo9996/agent-fence/actions/workflows/ci.yml/badge.svg)](https://github.com/Abelo9996/agent-fence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![agent-fence check denying "cd app && git push --force" and "cat .env" with the matching rule and reason, and allowing "npm test"](docs/demo.gif)

**用一个权限策略文件，统一决定你机器上每个编程智能体可以运行、读取和写入什么，并记录下它们尝试过的每一个操作。**

规则只需在 `.agent-fence.toml` 里写一次。Claude Code 和 Codex 通过各自的 hooks 执行这些规则，其他任何智能体都可以通过一个包装器（wrapper）来运行命令。每一次决策都会追加到本地的审计日志里，你可以清楚地看到智能体尝试做了什么、哪些被拦了下来。

## 快速开始（30 秒）

```bash
npm install -g @abelo9996/agent-fence    # or: npx @abelo9996/agent-fence <command>

cd your-project
agent-fence init                               # commented starter .agent-fence.toml
agent-fence hooks install --agent claude       # PreToolUse hook in .claude/settings.local.json
agent-fence check --input "cd app && rm -rf ~" # DENY, exit code 3
agent-fence log                                # what your agents tried in this project
```

需要 Node 20 或更高版本。没有原生依赖。

Homebrew（macOS 和 Linux）：`brew install abelo9996/tap/agent-fence` 会安装 `agent-fence` 和 `agent-fence-shell`。

## 作为 Claude Code 插件安装

在 Claude Code 里运行：

```text
/plugin marketplace add Abelo9996/open-agent-lab
/plugin install agent-fence@open-agent-lab
```

然后运行 `/reload-plugins` 或开一个新会话。插件会加入 agent-fence skill、`PreToolUse` hook（检查的工具和 `agent-fence hooks install --agent claude` 相同，但不改任何 settings 文件）、`/agent-fence:explain [rule-id]`（不带 id 时解释本项目最近一次拦截或审批提示）以及 `/agent-fence:log`。装了插件就不要再运行 `agent-fence hooks install --agent claude`，否则每次调用都会被检查两遍。在终端里也可以：`claude plugin marketplace add Abelo9996/open-agent-lab`，然后 `claude plugin install agent-fence@open-agent-lab`。需要 Claude Code 2.1.139 或更新版本，以及 Node 20+。

hook 不需要额外安装：没有全局安装时，它通过 `npx -y @abelo9996/agent-fence` 运行，第一次使用时会下载这个包。每次被检查的工具调用（包括 Read、Glob 和 Grep）都要等它完成。在一台 Apple M 系列笔记本上实测，经由 npx 每次约 0.45 秒；全局安装后约 0.12 秒，插件只要在 PATH 里找到 agent-fence 就会自动使用它：

```bash
npm install -g @abelo9996/agent-fence
```

如果 hook 根本无法运行（没有 Node，或 npx 下载不了这个包），Claude Code 会显示 hook 错误，这次调用不会被检查，这和 settings 里的 hook 命令不存在时一样。`agent-fence hooks status --agent claude` 会显示插件最近一次检查调用的时间。

## 作为 Codex 插件安装

```bash
codex plugin marketplace add Abelo9996/open-agent-lab
codex plugin add agent-fence@open-agent-lab
```

这会加入 skill，以及一个针对 Bash、apply_patch、Edit、Write、Read 的 `PreToolUse` hook，运行 `npx -y @abelo9996/agent-fence hook codex`。Codex 只有在你信任插件的 hook 之后才会运行它：启动 `codex`，打开 `/hooks` 并信任 agent-fence 的 hook（见 [Codex hook 信任](#codex-hook-信任)）。和 `hooks install --agent codex` 一样，ask 规则会被拦截，并提示智能体去问你。插件和 `agent-fence hooks install --agent codex` 二选一，不要同时使用。

## 策略示例

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

`agent-fence test` 会运行其中的 `[[tests]]`，这样团队就能在 CI 里对自己的策略做单元测试。

## 在 CI 中使用

这个仓库同时也是一个 GitHub Action。它会对你的策略运行 `agent-fence test`，在作业摘要（job summary）里写出通过的测试、失败的测试以及被遮蔽的规则（因为总有另一条规则胜出，所以永远不会做出决策的规则），并在有测试失败时让作业失败。

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

同样的文件也在 [examples/agent-fence-policy.yml](examples/agent-fence-policy.yml)。

| 输入 | 默认值 | 含义 |
| --- | --- | --- |
| `policy` | `.agent-fence.toml` | 策略文件，相对于 `working-directory`。文件中的相对路径以它自己所在的目录为基准。|
| `version` | `0.2.0` | 从 npm 安装的 agent-fence 版本（`npx @abelo9996/agent-fence@<version>`）。也可以填一个软件包 tarball 的路径。|
| `args` | | 传给 `agent-fence test` 的额外参数，按空白字符拆分。|
| `fail-on-shadowed` | `false` | 有规则被遮蔽时也让作业失败。|
| `node-version` | `24` | `actions/setup-node` 使用的 Node.js 版本。|
| `working-directory` | `.` | 运行目录。|

输出：`result`（`pass` 或 `fail`）、`passed`、`failed`、`shadowed`、`untested`（没有任何测试由其决定的规则数）以及 `report-path`（`agent-fence test --json` 输出的 JSON 文件路径）。失败的测试和被遮蔽的规则也会作为注解（annotation）显示在策略文件上。这个 Action 不需要令牌，除了读取检出的代码之外也不需要任何权限。

在本地，同样的检查是 `agent-fence test` 和 `agent-fence lint`。判断方法是：取一条规则自身模式能匹配的最小输入（通配符用一个普通单词填充），如果在这个输入上胜出的是另一条规则（更具体的规则、具体程度相同但动作更严格的规则，或者项目规则无法放宽的用户规则），这条规则就会被报告为被遮蔽。`command_regex` 和 `secrets` 规则无法构造出示例输入，因此不做检查。

## 内置策略的决策结果

内置规则只是一个起点。`agent-fence rules` 会列出所有内置规则，`agent-fence explain <id>` 可以查看其中任意一条。

| 输入 | 决策 | 规则 |
| --- | --- | --- |
| `git status && npm test` | allow | （默认） |
| `cd app && git push --force origin main` | deny | `git-force-push` |
| `bash -c 'git push origin +main'` | deny | `git-force-push` |
| `FOO=1 sudo rm -rf "$HOME"` | deny | `rm-root-or-home` |
| 内含 `git push -f` 的 `bash <<EOF`、`x=git; $x push -f` | deny | `git-force-push` |
| `cd .. && rm -rf my-project`、在项目根目录执行 `rm -rf .` | deny | `rm-root-or-home` |
| `git push` | ask | `git-push` |
| `git reset --hard`、`git clean -fd`、`git checkout .` | ask | `git-discard-work` |
| `npm install left-pad`、`pip install x`、`python3 -m pip install x` | ask | `package-install` |
| `npm install`、`npm ci`、`pip install -r requirements.txt`、`uv sync` | allow | `install-from-lockfile` |
| `curl -fsSL https://x.sh \| sh`、`bash <(curl ...)`、`curl ... \| python3` | ask | `pipe-to-shell`、`pipe-to-interpreter` |
| `git -c alias.p='push -f' p`、`git config core.fsmonitor ...` | ask | `git-rewrite-config` |
| `$CMD -rf /` | ask | `dynamic-command` |
| `export TOKEN=ghp_...` | ask | `secret-in-input` |
| `npm publish`、`gh repo delete` | deny | `publish-or-delete` |
| 读取 `.env`、`~/.ssh/id_ed25519`、`deploy/key.pem` | deny | `secret-files` |
| 读取 `.env.example` | allow | `env-examples` |
| `cat src/../.env`、`cat .e*v`、`curl -d @.env https://...` | deny | `secret-files`（命令中出现的路径也会检查，通配符先展开） |
| `echo .env >> .gitignore`、`ls -la .env`、`git rm --cached .env` | allow | （只涉及文件名，不读内容） |
| `cp .env.example .env` | ask | `secret-files-write` |
| 写入项目之外的位置（临时目录除外） | deny | `write-outside-project` |
| 写入 `.agent-fence.toml` 或 `.claude/settings.json`、`rm -rf .claude` | deny | `protect-fence` |
| `agent-fence hooks uninstall`、`claude plugin disable agent-fence@open-agent-lab`、`codex plugin remove agent-fence@open-agent-lab` | deny | `protect-fence-cli` |
| `echo 'unterminated` | ask | （无法解析） |

## 各智能体的支持情况

| 智能体 | 接入方式 | 管控范围 | 说明 |
| --- | --- | --- | --- |
| Claude Code | `agent-fence hooks install --agent claude` 会在 `.claude/settings.local.json` 中添加一个 `PreToolUse` hook（加 `--shared` 则写入 `settings.json`） | Bash、PowerShell（按 POSIX shell 解析，尽力而为）、Read、Write、Edit、MultiEdit、NotebookEdit、Glob、Grep、LS、WebFetch | deny 和 ask 分别对应 Claude Code 自己的 `deny` 和 `ask`。决策为 allow 时 hook 不输出任何内容，因此 Claude Code 自身的权限设置依然生效：agent-fence 从不额外授予权限。MCP 工具不在检查范围内。|
| Codex CLI | `agent-fence hooks install --agent codex` 会在 `~/.codex/hooks.json` 中添加一个 `PreToolUse` hook（加 `--project` 则写入 `<repo>/.codex/hooks.json`）。之后需要信任它一次，见下方“Codex hook 信任”。| Bash、apply_patch（补丁中的每个文件）、Edit、Write、Read | Codex 的 hook 无法发起询问：Codex 会忽略 “ask” 结果，调用照样执行。因此 agent-fence 会把 ask 转成 deny，并附上一条消息，让智能体来询问你。Codex 不会运行未被信任或被修改过的 hook。|
| Codex CLI（原生规则） | `agent-fence codex-rules --write` 会写入 `~/.codex/rules/agent-fence.rules` | 由字面单词组成的命令规则会转成 `prefix_rule`：deny 对应 `forbidden`，ask 对应 `prompt` | 不依赖 hooks 也能工作，并且会弹出真正的审批提示。但 Codex 是按顺序匹配 argv 前缀的，所以 `git push --force` 拦不住 `git push origin main --force`。包含 `*` 的模式、路径规则和密钥检测都不会导出。请与 hook 配合使用。|
| 任意智能体 | `agent-fence exec -- <cmd> [args]` | 该命令本身，以及它串联或嵌套的所有命令 | 只检查通过包装器运行的命令。ask 需要终端；没有终端时会直接拦截（退出码 126）。|
| 遵循 `SHELL` 的智能体 | `SHELL=$(which agent-fence-shell)` | 每一段 `-c` 脚本，以及传给它的脚本文件 | 仅支持 POSIX。真正的 shell 是 `AGENT_FENCE_REAL_SHELL` 或 `/bin/bash`。直接启动 `/bin/bash` 的智能体会忽略 `SHELL`。交互式会话直接放行，不做检查。|

### Codex hook 信任

Codex 只运行已被信任的新 hook 或改动过的 hook，而 `codex exec` 会静默跳过未被信任的 hook。执行 `hooks install --agent codex` 之后：

1. 在终端里启动一次 `codex`（任意目录）。
2. 出现 “Hooks need review”（“1 hook is new or changed”）提示时，选择 **Trust all and continue**，或选择 **Review hooks** 只信任 agent-fence 这一个。之后可以在 Codex 中用 `/hooks` 查看。
3. 运行 `agent-fence hooks status --agent codex`，应显示 `trusted in Codex`。Codex 把信任记录在 `config.toml` 的 `[hooks.state]` 下；用不同的 `--command` 重新安装后需要重新信任。

已在 Codex 0.160.0 上验证：信任之后，`codex exec` 会带着 agent-fence 的原因拦下 `cat .env`，两次调用都会出现在 `agent-fence log` 中。对于已经审核过 hook 的 CI 或容器环境，可以用 `codex exec --dangerously-bypass-hook-trust` 跳过这个提示。

## 策略参考

策略使用 TOML 格式，由三层合并而成：

1. 内置默认规则（用 `agent-fence rules` 查看），
2. 用户策略：`~/.config/agent-fence/policy.toml`（会遵循 `$XDG_CONFIG_HOME`；Windows 上是 `%APPDATA%\agent-fence\policy.toml`；可以用 `AGENT_FENCE_CONFIG` 覆盖），
3. 项目策略：项目根目录下的 `.agent-fence.toml`（取最近的包含该文件的目录，否则取 git 根目录）。

`agent-fence init --user` 会生成一份用户策略的初始模板。

### 规则

| 键 | 含义 |
| --- | --- |
| `id` | 唯一名称。后面一层中 id 相同的规则会替换前面一层的规则。|
| `action` | `allow`、`ask` 或 `deny`。|
| `reason` | 会展示给智能体（以及你）。请写成一条指令。|
| `tool` | `bash`、`read`、`write`、`fetch`，或者它们组成的列表。省略时根据匹配条件推断。|
| `command` | 一个或多个 shell 命令模式，见下文。|
| `command_regex` | 对每一条简单命令进行匹配的正则表达式。|
| `path` | 一个或多个路径 glob。`**` 可以跨目录；`~/` 表示你的主目录；以 `**` 开头的模式可以匹配任意位置；其他相对模式都相对于项目根目录。除非 `tool` 另有指定，否则同时作用于读和写。|
| `outside_project` | `true`：匹配项目根目录之外的任何路径。|
| `secrets` | `true`：匹配包含疑似凭据字符串（云服务密钥、token、私钥、`PASSWORD=...`）的 shell 输入或写入内容。|
| `url` | 一个或多个 URL glob，用于 fetch 类工具。|
| `dynamic` | `true`：匹配程序名来自变量或命令替换的命令。|
| `piped_input` | 与 `command` 搭配使用：仅在 stdin 是管道时匹配（`curl ... \| sh`）。|
| `priority` | 加到规则具体度上的数值。|

顶层配置：`disable = ["id", ...]` 用来移除前面层级的规则；`[defaults]` 用来设置没有任何规则匹配时的动作（`bash`、`read`、`write`、`fetch`，默认都是 `allow`），以及无法解析的 shell 输入的动作（`unparsable`，默认 `ask`）。

### 命令模式

`git push --force` 的含义是：程序是 `git`（不限目录，所以 `/usr/bin/git` 也算），参数中出现了 `push`，并且 `--force` 出现在任意位置。以 `-` 开头的单词是 flag，顺序不限；像 `-f` 这样的单字母 flag 也能匹配 `-rf` 这类组合 flag 中的对应字母。其他单词必须按给定顺序出现，中间可以夹杂任意内容。单词内部可以使用 `*`、`?` 和 `{a,b}`；`\*` 表示字面上的星号。`~`、`$HOME` 和 `${HOME}` 是等价的。

匹配之前，命令会被拆分成它实际会执行的每一条简单命令：`&&`、`||`、`;`、`|`、`&`、换行、`( )`、`{ }`、`$( )`、反引号、`<( )`、`if`/`while` 的语句体、`sh -c` / `bash -lc` / `zsh -c` 脚本、`eval`，以及 `sudo`、`env`、`nohup`、`nice`、`timeout`、`xargs`、`find -exec` 等命令所包装的命令。引号会按 shell 的方式去除（`r''m` 就是 `rm`），`VAR=value` 前缀会被剥离，heredoc 的内容会被跳过。文件参数、重定向目标（`> file`），以及 `rm`、`cp`、`mv`、`tee`、`touch`、`sed -i` 等命令的目标路径，都会与路径规则进行比对，而这只会让决策变得更严格。解析相对路径时，会跟随命令链中更早出现的 `cd`。

### 决策是如何做出的

1. 所有匹配条件命中的规则都是候选规则。
2. 具体度最高的候选规则胜出。具体度等于所命中模式中字面（非通配符）字符的数量，再加上 `priority`。`outside_project`、`secrets` 和 `dynamic` 的具体度为 0。
3. 具体度相同时，deny 优先于 ask，ask 优先于 allow。再相同时，项目策略优先于用户策略，用户策略优先于内置规则。
4. 一条 shell 命令会针对其中每条简单命令、每个被检查的路径分别做出决策；最终结果取其中最严格的那个。
5. 如果没有任何规则匹配，就使用 `[defaults]`。

项目策略可以放宽内置默认规则，但不能放宽你的用户策略：它不能替换或禁用用户规则；当某条用户规则以 ask 或 deny 命中时，在这次检查中，动作更宽松的项目规则会被忽略。标记为 `locked` 的规则（例如 `protect-fence`）不能被项目策略修改。在内置策略中，`write-outside-project` 的 priority 为 -100，`write-temp` 为 -50，所以你写的任何路径规则都会排在它们前面。

### 路径

所有路径都会转换为绝对路径，`~` 和 `$HOME` 会被展开，`..` 会被折叠，反斜杠会被视为路径分隔符，路径中实际存在的部分会解析符号链接。在 macOS 和 Windows 上匹配时不区分大小写。

## 命令

| 命令 | 作用 |
| --- | --- |
| `agent-fence check --tool bash --input "<cmd>"` | 打印决策结果。也支持 `--tool read|write|edit --path <p>`、`--tool fetch --url <u>`、`--json`。退出码：0 表示 allow，2 表示 ask，3 表示 deny，1 表示出错。|
| `agent-fence init [--user] [--force]` | 生成一份带注释的初始策略。|
| `agent-fence rules [--json]` | 列出所有生效的规则，以及每条规则来自哪个文件。|
| `agent-fence explain <rule-id>` | 查看某条规则的来源、匹配条件、原因、覆盖关系和测试。|
| `agent-fence test [--json] [--strict]` | 运行 `[[tests]]`；任何一项失败都以 1 退出。同时会对被遮蔽的规则给出警告（加 `--strict` 时视为失败）。|
| `agent-fence lint [--json]` | 列出被遮蔽的规则（永远不会做出决策的规则）以及没有任何测试由其决定的规则。有规则被遮蔽时以 1 退出。|
| `agent-fence log [-n 50] [--action deny] [--tool bash] [--source claude] [--since 2h] [--all] [--json]` | 读取当前项目（或全部项目）的审计日志。`--path` 会打印日志所在位置。|
| `agent-fence hooks install\|uninstall\|status --agent claude\|codex [--shared\|--project]` | 管理 hooks。已有的设置会被合并而不是替换，并且会先做备份。|
| `agent-fence codex-rules [--write\|--out <file>]` | 把命令规则导出为 Codex 的 `prefix_rule`。|
| `agent-fence exec -- <cmd> [args]` | 先检查，再不经过 shell 直接运行。被拦截时退出码为 126。|
| `agent-fence shell -c "<script>"` / `agent-fence-shell` | 一个替代 shell，会先检查脚本再执行。|

`--policy <file>` 可用于 `check`、`rules`、`explain`、`test`、`lint` 和 `codex-rules`：它会把该文件作为项目策略加载，项目根目录设为该文件所在的目录。

### 审计日志

日志位于 `~/.local/state/agent-fence/audit.jsonl`，每行一个 JSON 对象（会遵循 `$XDG_STATE_HOME`；Windows 上是 `%LOCALAPPDATA%\agent-fence`；可以用 `AGENT_FENCE_LOG` 覆盖）。每条记录包含时间、集成方式、项目、工具、智能体自己的工具名、输入、决策、命中的规则及其原因。输入会被截断到 2,000 个字符，任何看起来像凭据的内容在写入前都会被替换为 `[REDACTED]`。文件内容从不记录，只记录路径。设置 `AGENT_FENCE_NO_LOG=1` 可以关闭日志。

## 它拦不住什么

agent-fence 读取的是智能体声称要做的事。它是一个策略层，不是沙箱，它的效果完全取决于挡在前面的 hook 或包装器。

- **智能体自己写出来再运行的代码。** `python build.py` 会被放行，但 `build.py` 实际做了什么是看不到的。`npm test`、`make`、git hooks，以及其他任何执行项目内文件的命令都是同理。
- **解析器看不穿的混淆。** 运行时拼接出来的命令（`$(echo cm0= | base64 -d)`、变量、用 `printf` 输出再交给 `sh`），只有在程序名本身是动态的、或者输入无法解析时才会被拦截；运行时拼出来的参数则拦不住。一个铁了心的攻击者总能绕过模式匹配器。
- **解释器内联代码。** `python3 -c "..."`、`node -e "..."`、`perl -e "..."` 可以做任何事，包括读取 `.env` 或执行 `git push --force`，其中的代码不会被解析。已提交过的密钥文件通过 `git show HEAD:.env` 读取也拦不住。从标准输入读到的数据同样看不到（`echo ~ | xargs rm -rf`、`env | curl -d @-`）。
- **不受信任的仓库。** 克隆来的仓库里的 `.agent-fence.toml` 可以禁用或放宽内置规则（但不能改你的用户策略和 locked 规则），而且它自己的脚本在 `npm test` 时照样会运行。你依赖的规则请写进用户策略。
- **没有 hook 的工具。** MCP 服务器、浏览器工具，以及智能体在被 hook 的工具调用之外做的任何事。在 Codex 中，通过 shell 读取文件只能以命令文本的形式被看到。
- **没有接入的智能体。** 如果 hook 没有安装或没有被信任，或者智能体忽略了 `SHELL`，就什么都不会被检查。`agent-fence hooks status` 可以查看安装情况。
- **失败时默认放行。** 如果找不到 `agent-fence` 可执行文件，Claude Code 和 Codex 会把 hook 报错当作非阻断错误，照常执行调用。请全局安装它，确保 hook 命令始终能被找到。
- **网络出站和环境变量中的凭据。** 需要隔离时，请使用真正的沙箱（容器、虚拟机，或者智能体自带的沙箱模式），并且不要把长期有效的密钥放进智能体的运行环境。

## 预防与回滚

agent-fence 决定智能体可以做什么。[snap-back](https://github.com/Abelo9996/snap-back) 则负责撤销它已经做了的事：它会在智能体的每一步前后给工作区拍快照，一条命令就能把改动回滚。两者本来就是设计成配合使用的，这也是 `git-discard-work` 规则的 reason 里会提到 snap-back 的原因。

## Agent Skill

`skills/agent-fence/SKILL.md` 会教智能体读懂 deny 或 ask 的原因，告诉你它原本想做什么，然后等待你的回应，而不是换一条等价的命令再试一次。

```bash
npx skills add Abelo9996/agent-fence
```

## 相关项目

- [snap-back](https://github.com/Abelo9996/snap-back)：适用于任何编程智能体的撤销功能。
- [nerf-watch](https://github.com/Abelo9996/nerf-watch)：检测悄无声息的模型变化和成本变化。
- [rerun-bench](https://github.com/Abelo9996/rerun-bench)：衡量智能体在多次重跑中有多稳定。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。找到了绕过某条规则的方法？请提交一份[策略绕过报告](https://github.com/Abelo9996/agent-fence/issues/new?template=policy_bypass.yml)。

## 许可证

[MIT](LICENSE)

如本文与英文版 [README](README.md) 有出入，以英文版为准。
