#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { handleHook } from "./adapters.js";
import { auditLogPath, parseSince, readAudit } from "./audit.js";
import { exportCodexRules } from "./codex-rules.js";
import { STARTER_POLICY } from "./defaults.js";
import { evaluate, type Request } from "./engine.js";
import { allHookTargets, hookInstalled, hookTarget, installHook, runningFromNpxCache, uninstallHook, type Agent } from "./hooks.js";
import { PROJECT_POLICY, findProjectRoot, homeDir, normalizePath, userPolicyPath } from "./paths.js";
import { loadPolicy, PolicyError, TOOLS, type Rule, type Tool } from "./policy.js";
import { describeTest, runPolicyTests } from "./policy-tests.js";
import { VERSION } from "./version.js";
import { runExec, runShell } from "./wrap.js";

export const EXIT = { allow: 0, error: 1, ask: 2, deny: 3 } as const;

function fail(msg: string, code = 1): never {
  process.stderr.write(`agent-fence: ${msg}\n`);
  process.exit(code);
}

function load(cwd = process.cwd()) {
  try {
    return loadPolicy({ cwd });
  } catch (e) {
    if (e instanceof PolicyError) fail(e.message);
    throw e;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function ruleLabel(r: Pick<Rule, "id" | "layer">): string {
  return `${r.id} (${r.layer === "builtin" ? "built-in" : r.layer})`;
}

function matcherText(r: Rule): string {
  const s = r.spec;
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  if (s.command) return "command: " + list(s.command).join(" | ") + (s.piped_input ? " (only with piped input)" : "");
  if (s.command_regex) return "command_regex: " + s.command_regex;
  if (s.path) return "path: " + list(s.path).join(" | ");
  if (s.outside_project) return "outside_project";
  if (s.secrets) return "secrets (credential-looking strings)";
  if (s.dynamic) return "dynamic (program name from a variable or substitution)";
  if (s.url) return "url: " + list(s.url).join(" | ");
  return "?";
}

const argv = process.argv.slice(2);

// exec and shell take raw arguments, so they bypass option parsing.
if (argv[0] === "exec") {
  const rest = argv.slice(1);
  process.exit(runExec(rest[0] === "--" ? rest.slice(1) : rest));
}
if (argv[0] === "shell") {
  process.exit(runShell(argv.slice(1)));
}

const cli = cac("agent-fence");

cli
  .command("check", "Decide one tool call and print the result")
  .option("--tool <tool>", `One of ${TOOLS.join(", ")} (edit is an alias for write)`, { default: "bash" })
  .option("--input <command>", "Shell command, for --tool bash")
  .option("--path <path>", "File path, for --tool read or write")
  .option("--content <text>", "Text being written, for --tool write")
  .option("--url <url>", "URL, for --tool fetch")
  .option("--cwd <dir>", "Directory to resolve relative paths against")
  .option("--json", "Print the decision as JSON")
  .example('agent-fence check --tool bash --input "cd app && git push --force"')
  .example("agent-fence check --tool read --path ~/.ssh/id_ed25519")
  .action((o: { tool: string; input?: string; path?: string; content?: string; url?: string; cwd?: string; json?: boolean }) => {
    const tool = (o.tool === "edit" ? "write" : o.tool) as Tool;
    if (!TOOLS.includes(tool)) fail(`unknown tool "${o.tool}"; use ${TOOLS.join(", ")} or edit`);
    const cwd = o.cwd ? path.resolve(o.cwd) : process.cwd();
    const req: Request = { tool, command: o.input !== undefined ? String(o.input) : undefined, path: o.path, content: o.content, url: o.url, cwd };
    if (tool === "bash" && req.command === undefined) fail("--tool bash needs --input");
    if ((tool === "read" || tool === "write") && !req.path) fail(`--tool ${tool} needs --path`);
    if (tool === "fetch" && !req.url) fail("--tool fetch needs --url");
    const policy = load(cwd);
    const d = evaluate(policy, req);
    if (o.json) {
      process.stdout.write(JSON.stringify(d, null, 2) + "\n");
    } else {
      process.stdout.write(`${d.action.toUpperCase()}\n`);
      process.stdout.write(`  rule:    ${d.rule} (${d.layer === "builtin" ? "built-in" : d.layer})\n`);
      if (d.pattern) process.stdout.write(`  matched: ${d.pattern}\n`);
      if (d.subject) process.stdout.write(`  subject: ${d.subject}\n`);
      process.stdout.write(`  reason:  ${d.reason}\n`);
    }
    process.exit(EXIT[d.action]);
  });

cli
  .command("init", `Write a commented starter ${PROJECT_POLICY}`)
  .option("--user", "Write the user-level policy instead")
  .option("-f, --force", "Overwrite an existing file")
  .action((o: { user?: boolean; force?: boolean }) => {
    const file = o.user ? userPolicyPath() : path.join(findProjectRoot(process.cwd()), PROJECT_POLICY);
    if (existsSync(file) && !o.force) fail(`${file} already exists (use --force to overwrite)`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, STARTER_POLICY);
    load();
    process.stdout.write(`Wrote ${file}\nNext: agent-fence test, then agent-fence hooks install --agent claude\n`);
  });

cli
  .command("rules", "List every effective rule (built-in, user, project)")
  .option("--json", "Print as JSON")
  .action((o: { json?: boolean }) => {
    const p = load();
    if (o.json) {
      process.stdout.write(JSON.stringify(p.rules.map((r) => ({ ...r.spec, layer: r.layer, file: r.file, tools: r.tools })), null, 2) + "\n");
      return;
    }
    for (const f of p.files) process.stdout.write(`${f.layer.padEnd(8)} ${f.loaded ? "" : "(not found) "}${f.file}\n`);
    process.stdout.write(`defaults: ${Object.entries(p.defaults).map(([k, v]) => `${k}=${v}`).join(" ")}\n\n`);
    for (const r of p.rules) {
      process.stdout.write(`${r.action.padEnd(5)} ${ruleLabel(r).padEnd(36)} ${r.tools.join(",").padEnd(16)} ${matcherText(r).slice(0, 90)}\n`);
    }
  });

cli.command("explain <rule-id>", "Show where a rule comes from, what it matches and why").action((id: string) => {
  const p = load();
  const r = p.rules.find((x) => x.id === id);
  const gone = p.overridden.filter((x) => x.rule.id === id);
  if (!r && !gone.length) fail(`no rule "${id}". Run agent-fence rules to list them.`);
  if (r) {
    process.stdout.write(`${r.id}\n`);
    process.stdout.write(`  action:   ${r.action}\n`);
    process.stdout.write(`  tools:    ${r.tools.join(", ")}\n`);
    process.stdout.write(`  matcher:  ${matcherText(r)}\n`);
    process.stdout.write(`  reason:   ${r.reason}\n`);
    process.stdout.write(`  source:   ${r.layer === "builtin" ? "built-in defaults" : r.file}${r.locked ? " (locked: a project policy cannot change it)" : ""}\n`);
    if (r.priority) process.stdout.write(`  priority: ${r.priority}\n`);
  } else {
    process.stdout.write(`${id} is not active.\n`);
  }
  for (const g of gone) process.stdout.write(`  overridden: ${ruleLabel(g.rule)} was ${g.by}\n`);
  const tests = p.tests.filter((t) => t.rule === id);
  for (const t of tests) process.stdout.write(`  test: ${describeTest(t)} expects ${t.expect}\n`);
});

cli.command("test", "Run the [[tests]] declared in the user and project policy").action(() => {
  const p = load();
  if (!p.tests.length) {
    process.stdout.write(`No [[tests]] found in ${p.files.filter((f) => f.layer !== "builtin").map((f) => f.file).join(" or ")}\n`);
    return;
  }
  const results = runPolicyTests(p);
  let failed = 0;
  for (const r of results) {
    if (r.pass) {
      process.stdout.write(`pass  ${describeTest(r.test)} -> ${r.decision!.action} (${r.decision!.rule})\n`);
    } else {
      failed++;
      const got = r.error ? `error: ${r.error}` : `${r.decision!.action} (${r.decision!.rule})`;
      const want = r.test.expect + (r.test.rule ? ` (${r.test.rule})` : "");
      process.stdout.write(`FAIL  ${describeTest(r.test)}: expected ${want}, got ${got}  [${r.test.file}]\n`);
    }
  }
  process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});

cli
  .command("log", "Show recent decisions from the audit log")
  .option("-n, --lines <n>", "How many entries", { default: 20 })
  .option("--action <action>", "Only allow, ask or deny")
  .option("--tool <tool>", "Only this tool (bash, read, write, fetch)")
  .option("--source <source>", "Only this integration (claude, codex, exec, shell)")
  .option("--since <when>", "Only entries newer than this (30m, 2h, 7d or a date)")
  .option("--all", "All projects, not only the current one")
  .option("--json", "Print raw JSON lines")
  .option("--path", "Print the log file path and exit")
  .action((o: { lines: number; action?: string; tool?: string; source?: string; since?: string; all?: boolean; json?: boolean; path?: boolean }) => {
    if (o.path) {
      process.stdout.write(auditLogPath() + "\n");
      return;
    }
    const root = normalizePath(findProjectRoot(process.cwd()), process.cwd());
    let since: Date | undefined;
    try {
      since = o.since ? parseSince(o.since) : undefined;
    } catch (e) {
      fail((e as Error).message);
    }
    const entries = readAudit().filter(
      (e) =>
        (o.all || e.project === root) &&
        (!o.action || e.action === o.action) &&
        (!o.tool || e.tool === o.tool) &&
        (!o.source || e.source === o.source) &&
        (!since || new Date(e.ts) >= since),
    );
    const shown = entries.slice(-Math.max(1, Number(o.lines) || 20));
    if (o.json) {
      for (const e of shown) process.stdout.write(JSON.stringify(e) + "\n");
      return;
    }
    if (!shown.length) {
      process.stdout.write(`No matching entries in ${auditLogPath()}${o.all ? "" : " for this project (try --all)"}\n`);
      return;
    }
    for (const e of shown) {
      const t = e.ts.replace("T", " ").slice(0, 19);
      const input = e.input.replace(/\s+/g, " ");
      process.stdout.write(`${t}  ${e.action.padEnd(5)} ${e.source.padEnd(6)} ${(e.agentTool ?? e.tool).padEnd(10)} ${input.length > 80 ? input.slice(0, 77) + "..." : input}`);
      process.stdout.write(e.action === "allow" ? "\n" : `  [${e.rule}]\n`);
    }
  });

cli
  .command("hooks <action>", "install, uninstall or status of agent hooks")
  .option("--agent <agent>", "claude or codex", { default: "claude" })
  .option("--shared", "Claude Code: use .claude/settings.json (usually committed) instead of settings.local.json")
  .option("--project", "Codex: use <project>/.codex/hooks.json instead of ~/.codex/hooks.json")
  .option("--command <cmd>", "Base command to run agent-fence (default: agent-fence if on PATH)")
  .action((action: string, o: { agent: string; shared?: boolean; project?: boolean; command?: string }) => {
    const agent = o.agent as Agent;
    if (agent !== "claude" && agent !== "codex") fail(`--agent must be claude or codex (for other agents see agent-fence exec and agent-fence-shell)`);
    const root = findProjectRoot(process.cwd());
    try {
      if (action === "install") {
        const t = hookTarget(agent, root, { shared: o.shared, project: o.project });
        const r = installHook(t, o.command);
        if (!r.changed) process.stdout.write(`Already installed in ${r.file}\n`);
        else process.stdout.write(`Added PreToolUse hook to ${r.file}${r.backup ? ` (backup: ${r.backup})` : ""}\n  command: ${r.command}\n`);
        if (!o.command && /[\\/]/.test(r.command)) {
          process.stdout.write(
            `Note: the hook runs agent-fence by absolute path${runningFromNpxCache() ? " from the npx cache, which can be cleaned up" : ""}. ` +
              `For a stable hook install it globally (npm install -g github:Abelo9996/agent-fence) and re-run this command.\n`,
          );
        }
        if (agent === "codex") {
          process.stdout.write(
            "Codex runs a new hook only after you trust it: start codex, run /hooks, review the agent-fence hook and trust it.\n" +
              "Codex hooks cannot prompt, so ask rules block with a message telling the agent to ask you.\n",
          );
        }
      } else if (action === "uninstall") {
        const targets = o.shared || o.project ? [hookTarget(agent, root, { shared: o.shared, project: o.project })] : allHookTargets(agent, root);
        for (const t of targets) {
          const r = uninstallHook(t);
          process.stdout.write(r.removed ? `Removed ${r.removed} hook(s) from ${r.file}${r.backup ? ` (backup: ${r.backup})` : ""}\n` : `Nothing to remove in ${r.file}\n`);
        }
      } else if (action === "status") {
        for (const t of allHookTargets(agent, root)) {
          const s = hookInstalled(t);
          process.stdout.write(`${t.scope.padEnd(8)} ${s === true ? "installed    " : s === false ? "not installed" : "error        "} ${t.file}${typeof s === "string" ? `: ${s}` : ""}\n`);
        }
      } else {
        fail(`unknown hooks action "${action}"; use install, uninstall or status`);
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

cli
  .command("hook <agent>", "Hook entry point (reads the agent's hook JSON on stdin)")
  .action(async (agent: string) => {
    if (agent !== "claude" && agent !== "codex") fail(`unknown agent "${agent}"`);
    const raw = await readStdin();
    const r = handleHook(agent as Agent, raw);
    if (r.stdout) process.stdout.write(r.stdout + "\n");
    process.exit(0);
  });

cli
  .command("codex-rules", "Translate command rules into Codex exec-policy rules (prefix_rule)")
  .option("--write", "Write to ~/.codex/rules/agent-fence.rules instead of printing")
  .option("--out <file>", "Write to this file instead of printing")
  .action((o: { write?: boolean; out?: string }) => {
    const p = load();
    const ex = exportCodexRules(p);
    const file = o.out ?? (o.write ? path.join(process.env.CODEX_HOME || path.join(homeDir(), ".codex"), "rules", "agent-fence.rules") : null);
    if (!file) {
      process.stdout.write(ex.text);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, ex.text);
      process.stdout.write(`Wrote ${ex.exported.length} prefix rules to ${file}\n`);
    }
    if (ex.skipped.length) {
      process.stderr.write(`Not exported (${ex.skipped.length}): ${ex.skipped.map((s) => s.rule + (s.pattern ? ` "${s.pattern}"` : "")).join(", ")}\n`);
    }
  });

cli.command("exec", "Check a command, then run it: agent-fence exec -- <command> [args...]");
cli.command("shell", "Act as a shell (-c script) that checks scripts first; usable as SHELL via agent-fence-shell");

cli.help();
cli.version(VERSION);

try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand) {
    if (cli.args.length) fail(`unknown command "${cli.args[0]}". Run agent-fence --help.`);
    if (!cli.options.help && !cli.options.version) cli.outputHelp();
  } else {
    await cli.runMatchedCommand();
  }
} catch (e) {
  fail((e as Error).message);
}


