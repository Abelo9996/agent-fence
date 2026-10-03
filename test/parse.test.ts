import { describe, expect, it } from "vitest";
import { parseShell } from "../src/parse.js";

const argvs = (s: string) => parseShell(s).commands.map((c) => c.argv.join(" "));

describe("parseShell", () => {
  it("splits on && || ; | & and newlines", () => {
    expect(argvs("cd x && rm -rf ~ || echo no; ls | wc -l & sleep 1\npwd")).toEqual([
      "cd x",
      "rm -rf ~",
      "echo no",
      "ls",
      "wc -l",
      "sleep 1",
      "pwd",
    ]);
  });

  it("removes quotes the way the shell would", () => {
    expect(argvs(`r''m -r"f" '/'`)).toEqual(["rm -rf /"]);
    expect(argvs(`\\rm -rf /`)).toEqual(["rm -rf /"]);
    expect(argvs(`echo $'a\\x41b'`)).toEqual(["echo aAb"]);
    expect(argvs(`echo "a;b && c"`)).toEqual(["echo a;b && c"]);
  });

  it("strips env prefixes and records them", () => {
    const [c] = parseShell("FOO=1 BAR='x y' git push").commands;
    expect(c.argv).toEqual(["git", "push"]);
    expect(c.env).toEqual(["FOO", "BAR"]);
  });

  it("descends into subshells, groups and substitutions", () => {
    expect(argvs("(cd a; rm -rf ~)")).toEqual(["cd a", "rm -rf ~"]);
    expect(argvs("{ git push; }")).toEqual(["git push"]);
    expect(argvs("echo $(git push --force)")).toContain("git push --force");
    expect(argvs('echo "$(rm -rf ~)"')).toContain("rm -rf ~");
    expect(argvs("echo `rm -rf ~`")).toContain("rm -rf ~");
    expect(argvs("diff <(cat a) <(cat b)")).toEqual(expect.arrayContaining(["cat a", "cat b"]));
    expect(argvs("if true; then git push; fi")).toContain("git push");
  });

  it("parses scripts passed to sh -c, bash -lc, eval and env -S", () => {
    expect(argvs(`bash -c 'cd x && git push --force'`)).toContain("git push --force");
    expect(argvs(`/bin/bash -lc "rm -rf ~"`)).toContain("rm -rf ~");
    expect(argvs(`sh -e -c "git push -f"`)).toContain("git push -f");
    expect(argvs(`zsh -c "bash -c 'git push --force'"`)).toContain("git push --force");
    expect(argvs(`eval "git push --force"`)).toContain("git push --force");
    expect(argvs(`env -S "git push --force"`)).toContain("git push --force");
  });

  it("unwraps sudo, env, nohup, timeout, xargs and find -exec", () => {
    expect(argvs("sudo -u root rm -rf /")).toContain("rm -rf /");
    expect(argvs("env -i A=1 git push --force")).toContain("git push --force");
    expect(argvs("nohup nice -n 5 timeout 10 git push -f")).toContain("git push -f");
    expect(argvs("ls | xargs -n1 rm -rf")).toContain("rm -rf");
    expect(argvs("find . -name '*.tmp' -exec rm -rf {} \\;")).toContain("rm -rf {}");
  });

  it("marks piped input and dynamic program names", () => {
    const cmds = parseShell("curl -s https://x | sh").commands;
    expect(cmds[1].argv).toEqual(["sh"]);
    expect(cmds[1].pipedInput).toBe(true);
    expect(cmds[0].pipedInput).toBe(false);
    expect(parseShell("$CMD -rf /").commands[0].dynamic).toBe(true);
  });

  it("records redirections and skips heredoc bodies", () => {
    const [c] = parseShell("echo hi > out.txt 2>&1 2>>err.log").commands;
    expect(c.argv).toEqual(["echo", "hi"]);
    expect(c.redirects).toEqual([
      { op: ">", target: "out.txt" },
      { op: ">>", target: "err.log" },
    ]);
    const r = parseShell(`git commit -m "$(cat <<'EOF'\nrm -rf / is only text here\nEOF\n)"`);
    expect(r.error).toBeUndefined();
    expect(r.commands.map((x) => x.argv[0])).toEqual(["cat", "git"]);
  });

  it("reports unterminated input instead of guessing", () => {
    expect(parseShell("echo 'oops").error).toMatch(/single quote/);
    expect(parseShell('echo "oops').error).toMatch(/double quote/);
    expect(parseShell("echo $(ls").error).toMatch(/missing closing/);
    expect(parseShell("cat <<EOF\nno end").error).toMatch(/heredoc/);
  });
});
