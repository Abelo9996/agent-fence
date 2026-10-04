/**
 * A deliberately conservative shell parser. It does not execute or expand
 * anything; it finds every simple command a script could run so each one can be
 * checked on its own. It understands quoting, `&&`, `||`, `;`, `|`, `&`,
 * newlines, subshells, `{ }` groups, `$( )`, backticks, process substitution,
 * redirections, heredocs, env-var prefixes, wrappers such as `sudo`, `env`,
 * `nohup`, `timeout`, `xargs` and `find -exec`, and nested `sh -c "..."` /
 * `bash -lc '...'` / `eval` scripts.
 */

export interface Redirect {
  op: string;
  target: string;
}

export interface SimpleCommand {
  /** Words after quote removal, env prefixes and wrappers stripped. argv[0] is the program as written. */
  argv: string[];
  redirects: Redirect[];
  /** Names of VAR=value prefixes. */
  env: string[];
  /** True when stdin comes from a pipe. */
  pipedInput: boolean;
  /** How this command was reached: e.g. ["sudo"], ["bash -c"], ["$()"]. Empty for top level. */
  via: string[];
  /** True when the program word contains an unexpanded $ or backtick substitution. */
  dynamic: boolean;
}

export interface ParseResult {
  commands: SimpleCommand[];
  /** Set when the script ended inside a quote, substitution or heredoc. */
  error?: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox"]);
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac", "time", "coproc"]);
const MAX_DEPTH = 8;

/** Marker inserted into a word where a $( ) or backtick substitution was. */
export const SUBST = "$(...)";
/** Marker inserted where a <( ) or >( ) process substitution was (a path to another command's output). */
export const PROC_SUBST = "<(...)";

/** True when a word contains a substitution marker, so its value is only known at run time. */
export function hasSubst(word: string): boolean {
  return word.includes(SUBST) || word.includes(PROC_SUBST);
}

interface RawCommand {
  words: string[];
  /** Per word: true if it was produced only from literal text (no quotes at all). */
  bare: boolean[];
  redirects: Redirect[];
  pipedInput: boolean;
  /** Set by finish() when this command is a shell that reads its script from stdin (bash <<EOF). */
  stdinShell?: string;
}

class Parser {
  i = 0;
  out: SimpleCommand[] = [];
  error?: string;
  pendingHeredocs: { delim: string; strip: boolean; owner: RawCommand }[] = [];
  /** Shell variables assigned earlier in the script (x=value), substituted into later words. */
  vars: Map<string, string>;
  constructor(
    readonly s: string,
    readonly depth: number,
    readonly via: string[],
    vars?: Map<string, string>,
  ) {
    this.vars = new Map(vars ?? []);
  }

  fail(msg: string) {
    if (!this.error) this.error = msg;
  }

  /** Parse until end of input or the given closing character at nesting depth 0. */
  parseList(stop?: string): void {
    const s = this.s;
    let cmd: RawCommand = { words: [], bare: [], redirects: [], pipedInput: false };
    let word: string | null = null;
    let bare = true;
    let redirectOp: string | null = null;

    const endWord = () => {
      if (word === null) return;
      if (redirectOp) {
        const op = redirectOp;
        redirectOp = null;
        if (op === "<<" || op === "<<-") {
          this.pendingHeredocs.push({ delim: word, strip: op === "<<-", owner: cmd });
        } else if (!((op === ">&" || op === "<&") && /^(\d+|-)$/.test(word))) {
          cmd.redirects.push({ op, target: word });
        }
      } else if (cmd.words.length === 0 && bare && KEYWORDS.has(word)) {
        // control keyword in command position: skip it
      } else {
        cmd.words.push(word);
        cmd.bare.push(bare);
      }
      word = null;
      bare = true;
    };
    const endCommand = (nextPiped: boolean) => {
      endWord();
      if (cmd.words.length || cmd.redirects.length) this.finish(cmd);
      cmd = { words: [], bare: [], redirects: [], pipedInput: nextPiped };
    };
    const add = (t: string, isBare = true) => {
      word = (word ?? "") + t;
      if (!isBare) bare = false;
    };

    while (this.i < s.length) {
      const c = s[this.i];
      if (stop && c === stop) {
        this.i++;
        endCommand(false);
        return;
      }
      if (c === " " || c === "\t" || c === "\r") {
        endWord();
        this.i++;
        continue;
      }
      if (c === "\n") {
        endCommand(false);
        this.i++;
        this.readHeredocs();
        continue;
      }
      if (c === "#" && word === null) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "\\") {
        const n = s[this.i + 1];
        if (n === "\n") {
          this.i += 2;
          continue;
        }
        if (n !== undefined) add(n, false);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) {
          this.fail("unterminated single quote");
          add(s.slice(this.i + 1), false);
          this.i = s.length;
          break;
        }
        add(s.slice(this.i + 1, end), false);
        this.i = end + 1;
        continue;
      }
      if (c === "$" && s[this.i + 1] === "'") {
        this.i += 2;
        add(this.readAnsiC(), false);
        continue;
      }
      if (c === '"') {
        this.i++;
        add(this.readDouble(), false);
        continue;
      }
      if (c === "$" && s[this.i + 1] === "(") {
        if (s[this.i + 2] === "(") {
          this.skipArith();
          add("$((...))");
          continue;
        }
        this.i += 2;
        this.sub(")", "$()");
        add(SUBST);
        continue;
      }
      if (c === "$" && s[this.i + 1] === "{") {
        const end = s.indexOf("}", this.i + 2);
        const name = end < 0 ? s.slice(this.i + 2) : s.slice(this.i + 2, end);
        add("${" + name + "}");
        this.i = end < 0 ? s.length : end + 1;
        continue;
      }
      if (c === "`") {
        this.i++;
        this.backtick();
        add(SUBST);
        continue;
      }
      if ((c === "<" || c === ">") && s[this.i + 1] === "(" && word === null) {
        this.i += 2;
        this.sub(")", c + "()");
        add(PROC_SUBST);
        continue;
      }
      if (c === "(") {
        // subshell or group; ( a; b ) behaves like a; b for our purposes
        endCommand(false);
        this.i++;
        const before = this.out.length;
        this.parseList(")");
        void before;
        continue;
      }
      if (c === ")") {
        endCommand(false);
        this.i++;
        continue;
      }
      if (c === ";" || c === "|" || c === "&") {
        const two = s.slice(this.i, this.i + 2);
        if (c === "&" && (s[this.i + 1] === ">")) {
          endWord();
          const op = s.slice(this.i, this.i + 3) === "&>>" ? "&>>" : "&>";
          this.i += op.length;
          redirectOp = op;
          continue;
        }
        if (two === "&&" || two === "||" || two === ";;" || two === "|&") {
          endCommand(two === "|&");
          this.i += 2;
          continue;
        }
        endCommand(c === "|");
        this.i++;
        continue;
      }
      if (c === "<" || c === ">") {
        // a pure digit word right before is an fd number
        if (word !== null && bare && /^\d+$/.test(word)) word = null;
        else endWord();
        let op = c;
        const rest = s.slice(this.i);
        for (const cand of ["<<<", "<<-", ">>", ">|", "<<", "<>", ">&", "<&"]) {
          if (rest.startsWith(cand)) {
            op = cand;
            break;
          }
        }
        this.i += op.length;
        redirectOp = op === "<<<" ? "<<<" : op;
        continue;
      }
      add(c);
      this.i++;
    }
    if (stop) this.fail(`missing closing ${stop}`);
    endCommand(false);
    if (redirectOp) this.fail("redirection without a target");
  }

  readDouble(): string {
    const s = this.s;
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const n = s[this.i + 1];
        if (n === '"' || n === "\\" || n === "$" || n === "`") {
          out += n;
          this.i += 2;
          continue;
        }
        if (n === "\n") {
          this.i += 2;
          continue;
        }
        out += c;
        this.i++;
        continue;
      }
      if (c === "$" && s[this.i + 1] === "(") {
        if (s[this.i + 2] === "(") {
          this.skipArith();
          out += "$((...))";
          continue;
        }
        this.i += 2;
        this.sub(")", "$()");
        out += SUBST;
        continue;
      }
      if (c === "`") {
        this.i++;
        this.backtick();
        out += SUBST;
        continue;
      }
      out += c;
      this.i++;
    }
    this.fail("unterminated double quote");
    return out;
  }

  readAnsiC(): string {
    const s = this.s;
    let out = "";
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "'") {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const n = s[this.i + 1] ?? "";
        if (n === "x") {
          const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(this.i + 2))?.[0] ?? "";
          out += hex ? String.fromCharCode(parseInt(hex, 16)) : "\\x";
          this.i += 2 + hex.length;
          continue;
        }
        if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(s.slice(this.i + 1))![0];
          out += String.fromCharCode(parseInt(oct, 8));
          this.i += 1 + oct.length;
          continue;
        }
        out += map[n] ?? "\\" + n;
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
    this.fail("unterminated $' quote");
    return out;
  }

  skipArith() {
    // at $(( ; skip to the matching ))
    let depth = 0;
    this.i += 1;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          this.i++;
          return;
        }
      }
      this.i++;
    }
    this.fail("unterminated arithmetic expansion");
  }

  /** Parse a nested command list in the same input (for $( ), <( ), >( )). */
  sub(stop: string, label: string) {
    if (this.depth >= MAX_DEPTH) {
      this.fail("nesting too deep");
    }
    const child = new Parser(this.s, this.depth + 1, [...this.via, label], this.vars);
    child.i = this.i;
    child.parseList(stop);
    this.i = child.i;
    this.out.push(...child.out);
    if (child.error) this.fail(child.error);
  }

  backtick() {
    let end = this.i;
    let inner = "";
    while (end < this.s.length && this.s[end] !== "`") {
      if (this.s[end] === "\\" && end + 1 < this.s.length) {
        inner += this.s[end + 1];
        end += 2;
        continue;
      }
      inner += this.s[end];
      end++;
    }
    if (end >= this.s.length) this.fail("unterminated backtick");
    this.i = end + 1;
    this.nested(inner, "``");
  }

  /** Parse a separate script string (sh -c, eval, backticks). */
  nested(script: string, label: string) {
    if (this.depth >= MAX_DEPTH) {
      this.fail("nesting too deep");
      return;
    }
    const child = new Parser(script, this.depth + 1, [...this.via, label], this.vars);
    child.parseList();
    this.out.push(...child.out);
    if (child.error) this.fail(child.error);
  }

  readHeredocs() {
    while (this.pendingHeredocs.length) {
      const { delim, strip, owner } = this.pendingHeredocs.shift()!;
      const body: string[] = [];
      for (;;) {
        if (this.i >= this.s.length) {
          this.fail(`unterminated heredoc ${delim}`);
          return;
        }
        let nl = this.s.indexOf("\n", this.i);
        if (nl < 0) nl = this.s.length;
        let line = this.s.slice(this.i, nl);
        this.i = Math.min(nl + 1, this.s.length);
        if (strip) line = line.replace(/^\t+/, "");
        if (line.replace(/\r$/, "") === delim) break;
        body.push(line);
      }
      // `bash <<EOF ... EOF` runs the heredoc body as a script.
      if (owner.stdinShell) this.nested(body.join("\n"), `${owner.stdinShell} <<`);
    }
  }

  /** Substitute variables assigned earlier in the script and split on $IFS, the way the shell would. */
  expandWords(raw: RawCommand): string[] {
    const out: string[] = [];
    raw.words.forEach((w, idx) => {
      const whole = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(w);
      const name = whole ? (whole[1] ?? whole[2]) : undefined;
      if (name !== undefined && raw.bare[idx] && this.vars.has(name)) {
        // an unquoted $x is split into words
        out.push(...this.vars.get(name)!.split(/\s+/).filter(Boolean));
        return;
      }
      let v = w.replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g, (m, a, b) => {
        const n = a ?? b;
        return this.vars.has(n) ? this.vars.get(n)! : m;
      });
      // $IFS expands to whitespace, which separates words.
      if (/\$(IFS\b|\{IFS\})/.test(v)) {
        out.push(...v.split(/\$(?:IFS\b|\{IFS\})/).filter(Boolean));
        return;
      }
      out.push(v);
    });
    return out;
  }

  finish(raw: RawCommand) {
    const words = this.expandWords(raw);
    const env: string[] = [];
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[k])) {
      env.push(words[k].split("=")[0].replace(/\+$/, ""));
      k++;
    }
    const argv = words.slice(k);
    // Remember plain assignments (x=1, export x=1) so later $x can be resolved.
    const assigns = argv.length === 0 ? words : /^(export|declare|typeset|local|readonly)$/.test(argv[0] ?? "") ? argv.slice(1) : [];
    for (const a of assigns) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
      if (m) this.vars.set(m[1], m[2]);
    }
    this.emit(argv, raw.redirects, env, raw.pipedInput, this.via);
    // A shell with no script argument reads its script from stdin: check here-strings and heredocs too.
    const shell = stdinShell(argv);
    if (shell) {
      raw.stdinShell = shell;
      for (const r of raw.redirects) if (r.op === "<<<") this.nested(r.target, `${shell} <<<`);
    }
  }

  emit(argv: string[], redirects: Redirect[], env: string[], pipedInput: boolean, via: string[]) {
    const prog = argv.length ? programName(argv[0]) : "";
    this.out.push({
      argv,
      redirects,
      env,
      pipedInput,
      via,
      dynamic: argv.length > 0 && (/[$`]/.test(argv[0]) || argv[0].includes(PROC_SUBST)),
    });
    if (!argv.length) return;
    if (via.length > MAX_DEPTH) {
      this.fail("nesting too deep");
      return;
    }
    const inner = unwrap(prog, argv);
    if (inner) {
      if (inner.argv.length) this.emit(inner.argv, [], [...env, ...inner.env], pipedInput, [...via, prog]);
      return;
    }
    if (SHELLS.has(prog) || prog === "source" || prog === ".") {
      const script = SHELLS.has(prog) ? shellScript(argv) : null;
      if (script !== null) this.nested(script, `${prog} -c`);
      else {
        // `bash <(curl ...)` and `source <(curl ...)` run another command's output as a script.
        const first = argv.slice(1).find((a) => !/^[-+]/.test(a));
        if (first !== undefined && first.includes(PROC_SUBST)) this.out[this.out.length - 1].pipedInput = true;
      }
      return;
    }
    if (prog === "eval") {
      this.nested(argv.slice(1).join(" "), "eval");
      return;
    }
    if (prog === "alias") {
      // alias gp='git push --force' makes gp run that text
      for (const a of argv.slice(1)) {
        const eq = a.indexOf("=");
        if (eq > 0) this.nested(a.slice(eq + 1), "alias");
      }
      return;
    }
    const run = runnerInner(prog, argv);
    if (run) {
      if (run.script !== undefined) this.nested(run.script, `${prog} -c`);
      else if (run.argv.length) this.emit(run.argv, [], env, pipedInput, [...via, prog]);
      return;
    }
    if (prog === "find") {
      for (let j = 1; j < argv.length; j++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(argv[j])) {
          let end = j + 1;
          while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
          const sub = argv.slice(j + 1, end);
          if (sub.length) this.emit(sub, [], [], false, [...via, "find -exec"]);
          j = end;
        }
      }
    }
  }
}

/** The bare program name: no directory, no .exe, lower-cased on Windows-style names. */
export function programName(word: string): string {
  let p = word.replace(/\\/g, "/");
  p = p.slice(p.lastIndexOf("/") + 1);
  if (/\.(exe|cmd|bat)$/i.test(p)) p = p.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return p;
}

/**
 * If argv (after wrappers such as sudo) is a shell that reads its script from
 * stdin, that shell's name; else null.
 */
function stdinShell(argv: string[]): string | null {
  let a = argv;
  for (let n = 0; n < MAX_DEPTH && a.length; n++) {
    const prog = programName(a[0]);
    const inner = unwrap(prog, a);
    if (inner) {
      a = inner.argv;
      continue;
    }
    if (!SHELLS.has(prog) || shellScript(a) !== null) return null;
    return a.slice(1).every((x) => /^[-+]/.test(x)) ? prog : null;
  }
  return null;
}

/** Package runners that run another program: npx tsc, npm exec -- x, uv run pytest. */
const RUNNERS: Record<string, { sub?: string[]; valued: string[]; script?: string[] }> = {
  npx: { valued: ["-p", "--package"], script: ["-c", "--call"] },
  pnpx: { valued: ["-p", "--package"], script: ["-c", "--call"] },
  bunx: { valued: ["-p", "--package"] },
  uvx: { valued: ["--from", "--with", "--python", "-p"] },
  npm: { sub: ["exec", "x"], valued: ["-p", "--package", "-w", "--workspace"], script: ["-c", "--call"] },
  pnpm: { sub: ["exec", "dlx"], valued: ["-p", "--package", "-C", "--dir", "--filter", "-F"], script: ["-c"] },
  yarn: { sub: ["exec", "dlx"], valued: ["-p", "--package"] },
  bun: { sub: ["x"], valued: ["-p", "--package"] },
  uv: { sub: ["run"], valued: ["--with", "--python", "-p", "--project", "--directory", "--package", "--env-file", "--extra", "--group", "--index", "--from"] },
  poetry: { sub: ["run"], valued: ["-C", "--directory", "-P", "--project"] },
  pipenv: { sub: ["run"], valued: [] },
  bundle: { sub: ["exec"], valued: [] },
  pipx: { sub: ["run"], valued: ["--spec", "--python"] },
};

/** For a package runner, the command it runs (or a -c script); else null. */
function runnerInner(prog: string, argv: string[]): { argv: string[]; script?: string } | null {
  const spec = RUNNERS[prog];
  if (!spec) return null;
  let j = 1;
  if (spec.sub) {
    // npm exec / uv run: skip global options before the subcommand
    while (j < argv.length && argv[j].startsWith("-")) j++;
    if (!spec.sub.includes(argv[j] ?? "")) return null;
    j++;
  }
  while (j < argv.length) {
    const a = argv[j];
    if (a === "--") {
      j++;
      break;
    }
    if (!a.startsWith("-") || a.length === 1) break;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (spec.script?.includes(name)) return { argv: [], script: a.includes("=") ? a.slice(a.indexOf("=") + 1) : (argv[j + 1] ?? "") };
    j++;
    if (spec.valued.includes(name) && !a.includes("=")) j++;
  }
  return { argv: argv.slice(j) };
}

/** For `bash -c 'script'`-style invocations, the script; else null. */
function shellScript(argv: string[]): string | null {
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === "--") return null;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      // the script is the first non-option argument after -c
      for (let m = j + 1; m < argv.length; m++) {
        if (argv[m] === "-o" || argv[m] === "+o") {
          m++;
          continue;
        }
        if (!/^[-+]/.test(argv[m])) return argv[m];
      }
      return "";
    }
    if (argv[0] && programName(argv[0]) === "busybox" && j === 1 && SHELLS.has(a)) continue;
    if (!/^[-+]/.test(a)) return null;
  }
  return null;
}

/** Option letters (or long names) that take a value, per wrapper. */
const WRAPPERS: Record<string, { valued: string[]; positional?: number }> = {
  sudo: { valued: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"] },
  doas: { valued: ["-u", "-C"] },
  env: { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  nohup: { valued: [] },
  command: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ["-a"] },
  nice: { valued: ["-n", "--adjustment"] },
  ionice: { valued: ["-c", "-n", "-p"] },
  time: { valued: ["-f", "-o", "--format", "--output"] },
  timeout: { valued: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  xargs: { valued: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"] },
  caffeinate: { valued: ["-t", "-w"] },
  chronic: { valued: [] },
  unbuffer: { valued: [] },
  watch: { valued: ["-n", "-d", "--interval"] },
};

/** If argv runs another command (sudo rm ...), the inner command. */
function unwrap(prog: string, argv: string[]): { argv: string[]; env: string[] } | null {
  const spec = WRAPPERS[prog];
  if (!spec) return null;
  const env: string[] = [];
  let j = 1;
  let positional = spec.positional ?? 0;
  while (j < argv.length) {
    const a = argv[j];
    if (a === "--") {
      j++;
      break;
    }
    if (prog === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      env.push(a.split("=")[0]);
      j++;
      continue;
    }
    if (prog === "env" && (a === "-S" || a === "--split-string") && argv[j + 1] !== undefined) {
      // env -S "cmd args" splits its argument into words
      const rest = argv[j + 1].split(/\s+/).filter(Boolean);
      return { argv: [...rest, ...argv.slice(j + 2)], env };
    }
    if (a.startsWith("-") && a.length > 1) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      j++;
      if (spec.valued.includes(name) && !a.includes("=")) j++;
      continue;
    }
    if (prog === "nice" && /^-\d+$/.test(a)) {
      j++;
      continue;
    }
    if (positional > 0) {
      positional--;
      j++;
      continue;
    }
    break;
  }
  return { argv: argv.slice(j), env };
}

export function parseShell(script: string): ParseResult {
  const p = new Parser(script, 0, []);
  p.parseList();
  if (p.pendingHeredocs.length) p.fail("unterminated heredoc");
  return { commands: p.out, error: p.error };
}
