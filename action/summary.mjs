// Turns the JSON from `agent-fence test --json` into the GitHub Actions job
// summary, log lines, annotations and step outputs. Used by action.yml; plain
// JavaScript with no dependencies so it runs straight from the action checkout.
//
// Usage: node summary.mjs <result.json> <stderr.txt> <exit code> <policy path>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Escape text for an HTML table cell in GitHub-flavored Markdown. */
function cell(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\r?\n/g, " ");
}

function code(text) {
  return `<code>${cell(text)}</code>`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function testLabel(t) {
  return t.name === `${t.tool} ${JSON.stringify(t.subject)}` ? `${t.tool} ${code(t.subject)}` : `${cell(t.name)}<br>${t.tool} ${code(t.subject)}`;
}

function got(t) {
  if (t.error) return `error: ${cell(t.error)}`;
  return `${t.action} (${code(t.rule)})`;
}

function want(t) {
  return t.expect + (t.expectRule ? ` (${code(t.expectRule)})` : "");
}

/**
 * Markdown for the job summary.
 * @param {object|null} result parsed JSON, or null when the CLI printed none
 * @param {{ policy: string, stderr?: string, exitCode: number, strict?: boolean }} opts
 */
export function renderMarkdown(result, opts) {
  const out = ["## agent-fence policy check", ""];
  if (!result || result.error) {
    const msg = result?.error ?? (opts.stderr || "").trim() ?? "no output";
    out.push(`**The policy could not be checked.** ${code(opts.policy)}`, "", "```text", msg.replace(/```/g, "'''") || "agent-fence printed nothing", "```", "");
    if (!result) out.push("If this says the option `--policy` or `--json` is unknown, set the `version` input to 0.2.0 or newer.", "");
    return out.join("\n");
  }
  const total = result.passed + result.failed;
  const status = result.failed ? "failed" : opts.exitCode ? "failed" : "passed";
  out.push(
    `${status === "passed" ? "Passed" : "Failed"}: ${code(opts.policy)}, ${plural(result.rules, "rule")}, ` +
      `**${result.passed} passed, ${result.failed} failed**` +
      (result.shadowed.length ? `, ${plural(result.shadowed.length, "shadowed rule")}` : "") +
      ` (agent-fence ${cell(result.version)})`,
    "",
  );
  if (!total) out.push("The policy has no `[[tests]]`, so only its syntax and rules were checked. Add `[[tests]]` cases to pin down what it decides.", "");
  const failures = result.tests.filter((t) => !t.pass);
  if (failures.length) {
    out.push("### Failed tests", "", "| Test | Expected | Got |", "| --- | --- | --- |");
    for (const t of failures) out.push(`| ${testLabel(t)} | ${want(t)} | ${got(t)} |`);
    out.push("");
  }
  if (result.shadowed.length) {
    out.push(
      "### Shadowed rules",
      "",
      `These rules never decide anything: for the smallest input each one matches, another rule wins.${opts.strict ? "" : " This is a warning; set `fail-on-shadowed: true` to fail the job."}`,
      "",
      "| Rule | Tried | Decided by | Why |",
      "| --- | --- | --- | --- |",
    );
    for (const s of result.shadowed) {
      const tried = `${s.tool} ${code(s.subject)}`;
      out.push(`| ${code(s.id)} (${s.layer}, ${s.action}) | ${tried} | ${code(s.winner.id)} (${s.winner.layer === "builtin" ? "built-in" : s.winner.layer}, ${s.winner.action}) | ${cell(s.why)} |`);
    }
    out.push("");
  }
  const passes = result.tests.filter((t) => t.pass);
  if (passes.length) {
    out.push(`<details><summary>${plural(passes.length, "test")} passed</summary>`, "", "| Test | Decision |", "| --- | --- |");
    for (const t of passes) out.push(`| ${testLabel(t)} | ${got(t)} |`);
    out.push("", "</details>", "");
  }
  if (result.untested.length) {
    out.push(`Rules no test is decided by: ${result.untested.map(code).join(", ")}.`, "");
  }
  if (result.notChecked.length) {
    out.push(`Not checked for shadowing (command_regex and secrets rules): ${result.notChecked.map(code).join(", ")}.`, "");
  }
  return out.join("\n");
}

/** Escape a workflow command message or property. */
function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProp(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** Plain log lines and ::error / ::warning annotations. */
export function renderLog(result, opts) {
  const lines = [];
  const workspace = process.env.GITHUB_WORKSPACE;
  const fileProp = (f) => {
    if (!f || !workspace) return "";
    const rel = path.relative(workspace, f);
    return rel.startsWith("..") || path.isAbsolute(rel) ? "" : `file=${escapeProp(rel.split(path.sep).join("/"))},`;
  };
  if (!result || result.error) {
    lines.push(`::error title=agent-fence::${escapeData(result?.error ?? (opts.stderr || "agent-fence printed no result").trim())}`);
    return lines;
  }
  for (const t of result.tests) {
    const name = t.name;
    if (t.pass) lines.push(`pass  ${name} -> ${t.action} (${t.rule})`);
    else {
      const g = t.error ? `error: ${t.error}` : `${t.action} (${t.rule})`;
      const w = t.expect + (t.expectRule ? ` (${t.expectRule})` : "");
      lines.push(`FAIL  ${name}: expected ${w}, got ${g}`);
      lines.push(`::error ${fileProp(t.file)}title=agent-fence test failed::${escapeData(`${name}: expected ${w}, got ${g}`)}`);
    }
  }
  lines.push("", `${result.passed} passed, ${result.failed} failed`);
  for (const s of result.shadowed) {
    const level = opts.strict ? "error" : "warning";
    const msg = `rule "${s.id}" never decides: for ${s.example} rule "${s.winner.id}" wins: ${s.why}`;
    lines.push(`::${level} ${fileProp(s.file)}title=agent-fence shadowed rule::${escapeData(msg)}`);
  }
  return lines;
}

function main() {
  const [resultFile, stderrFile, exitArg, policy] = process.argv.slice(2);
  const exitCode = Number(exitArg) || 0;
  const strict = (process.env.AF_STRICT || "").toLowerCase() === "true";
  const stderr = stderrFile && existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "";
  let result = null;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    result = null;
  }
  const opts = { policy, stderr, exitCode, strict };
  for (const l of renderLog(result, opts)) console.log(l);
  if (!result || result.error) console.log(stderr.trim());
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(result, opts) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    const ok = result && !result.error;
    const outputs = {
      passed: ok ? result.passed : 0,
      failed: ok ? result.failed : 0,
      shadowed: ok ? result.shadowed.length : 0,
      untested: ok ? result.untested.length : 0,
      result: ok && exitCode === 0 ? "pass" : "fail",
      "report-path": resultFile,
    };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
  process.exit(result && !result.error ? exitCode : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
