import picomatch from "picomatch";
import { programName, type SimpleCommand } from "./parse.js";
import { caseInsensitive, expandHome, homeDir, normalizePath, toPosix } from "./paths.js";

/** Expand one level of {a,b} alternatives. Nested braces are kept literal. */
export function expandBraces(p: string): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(p);
  if (!m) return [p];
  const head = p.slice(0, m.index);
  const tail = p.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
}

/** Compile a single-word glob: * matches anything (including /), ? one char, \* a literal star. */
export function wordGlob(p: string): RegExp {
  let re = "";
  let escaped = false;
  for (const ch of p) {
    if (escaped) {
      re += escapeRe(ch);
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += escapeRe(ch);
  }
  return new RegExp("^" + re + "$");
}

/** Count of characters that are not wildcards. Used for specificity. */
export function literalLength(p: string): number {
  return Math.min(...expandBraces(p).map((a) => a.replace(/\\./g, "x").replace(/[*?]/g, "").length));
}

/** Turn a word as an agent wrote it into the form patterns are written against. */
export function normalizeWord(w: string): string {
  let out = w.replace(/^(\$HOME|\$\{HOME\})(?=$|\/)/, "~");
  const home = toPosix(homeDir());
  if (out === home || out.startsWith(home + "/")) out = "~" + out.slice(home.length);
  if (out.length > 1 && /^[~/.]/.test(out)) out = out.replace(/\/+$/, "") || "/";
  out = out.replace(/\/{2,}/g, "/");
  return out;
}

export interface CommandPattern {
  source: string;
  program: RegExp[];
  /** Positional words, matched in order as a subsequence of the arguments. */
  positional: RegExp[][];
  /** Flag words, matched anywhere among the arguments. Each entry is a set of alternatives. */
  flags: string[][];
  specificity: number;
}

/**
 * A command pattern is a list of words. The first word matches the program name
 * (its basename, so `rm` also matches `/bin/rm`). Words starting with `-` are
 * flags and may appear anywhere among the arguments; a single-letter flag such as
 * `-f` also matches inside a cluster such as `-rf`. Other words must appear in
 * the given order, but other arguments may sit between them. Each word may use
 * `*`, `?` and `{a,b}`.
 */
export function compileCommandPattern(source: string): CommandPattern {
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("empty command pattern");
  const [first, ...rest] = words;
  const program = expandBraces(first).map(wordGlob);
  const positional: RegExp[][] = [];
  const flags: string[][] = [];
  for (const w of rest) {
    const alts = expandBraces(w);
    if (alts.every((a) => a.startsWith("-") && a.length > 1)) flags.push(alts);
    else positional.push(alts.map((a) => wordGlob(normalizeWord(a))));
  }
  return { source, program, positional, flags, specificity: words.reduce((n, w) => n + literalLength(w), 0) };
}

function flagMatches(alt: string, arg: string): boolean {
  if (/^-[A-Za-z0-9]$/.test(alt)) {
    if (arg === alt) return true;
    // short-flag cluster: -rf contains -f
    return /^-[A-Za-z0-9]{2,}$/.test(arg) && arg.includes(alt[1]);
  }
  if (alt.startsWith("--")) {
    if (arg === alt || arg.startsWith(alt + "=")) return true;
  }
  return wordGlob(alt).test(arg);
}

export function matchCommand(p: CommandPattern, cmd: SimpleCommand): boolean {
  if (!cmd.argv.length) return false;
  const prog = programName(cmd.argv[0]);
  if (!p.program.some((r) => r.test(prog))) return false;
  const args = cmd.argv.slice(1);
  for (const alts of p.flags) {
    if (!args.some((a) => a.startsWith("-") && alts.some((alt) => flagMatches(alt, a)))) return false;
  }
  let k = 0;
  for (const alts of p.positional) {
    let found = false;
    while (k < args.length) {
      const a = normalizeWord(args[k++]);
      if (alts.some((r) => r.test(a))) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

export interface PathPattern {
  source: string;
  test: (normalizedPath: string) => boolean;
  specificity: number;
}

/**
 * Path globs. `**` crosses directories. A pattern starting with `/`, a drive
 * letter, or `~/` is absolute; one starting with `**` matches anywhere; any
 * other relative pattern is relative to the project root.
 */
export function compilePathPattern(source: string, root: string): PathPattern {
  const tests = expandBraces(source).map((alt) => {
    let p = toPosix(alt.trim());
    if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(p)) p = toPosix(expandHome(p));
    if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p) && !p.startsWith("**")) {
      p = toPosix(root).replace(/\/$/, "") + "/" + p.replace(/^\.\//, "");
    }
    // resolve symlinks in the literal leading directories (e.g. /tmp -> /private/tmp)
    const segs = p.split("/");
    const firstGlob = segs.findIndex((s) => /[*?[]/.test(s));
    if (!p.startsWith("**") && firstGlob !== 0) {
      const base = (firstGlob < 0 ? segs : segs.slice(0, firstGlob)).join("/") || "/";
      const normBase = normalizePath(base, "/");
      p = firstGlob < 0 ? normBase : normBase.replace(/\/$/, "") + "/" + segs.slice(firstGlob).join("/");
    }
    return picomatch(p, { dot: true, nocase: caseInsensitive(), windows: false });
  });
  return { source, test: (np) => tests.some((t) => t(np)), specificity: literalLength(source) };
}
