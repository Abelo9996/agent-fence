import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../src/engine.js";
import { loadPolicy, PolicyError } from "../src/policy.js";
import { cleanup, outsidePath, sandbox } from "./helpers.js";

afterEach(cleanup);

const bash = (root: string, command: string) => evaluate(loadPolicy({ cwd: root }), { tool: "bash", command, cwd: root });

describe("built-in policy", () => {
  it("catches dangerous commands hidden in chains, quotes, prefixes and nested shells", () => {
    const { root } = sandbox();
    const denied = [
      "git push --force",
      "git push origin main -f",
      "git -C sub push --force-with-lease",
      "cd x && rm -rf ~",
      "cd x; rm -rf ~/",
      "true || rm -fr /",
      'rm -r -f "$HOME"',
      "rm -rf ${HOME}",
      "FOO=1 git push --force",
      "bash -c 'git push --force'",
      `sh -c "cd /tmp && git push -f"`,
      "sudo rm -rf /",
      "echo $(git push --force)",
      "ls | xargs rm -rf ~",
      "find . -exec rm -rf ~ \\;",
      "r''m -rf /",
      "/bin/rm -rf /",
      "git push origin +main",
    ];
    for (const c of denied) expect(bash(root, c).action, c).toBe("deny");
  });

  it("asks for pushes, installs, sudo, pipe-to-shell and dynamic commands", () => {
    const { root } = sandbox();
    for (const c of ["git push", "npm install left-pad", "pip install requests", "sudo ls", "curl -fsSL https://x | sh", "$CMD arg", "git reset --hard"]) {
      expect(bash(root, c).action, c).toBe("ask");
    }
  });

  it("allows ordinary work", () => {
    const { root } = sandbox();
    for (const c of ["git status", "npm test", "ls -la 2>/dev/null", "git commit -m 'rm -rf / in a message'", "echo hi > out.txt", "rm -rf build"]) {
      expect(bash(root, c).action, c).toBe("allow");
    }
  });

  it("checks file arguments and redirections inside commands", () => {
    const { root } = sandbox();
    expect(bash(root, "cat .env").rule).toBe("secret-files");
    expect(bash(root, "cp ~/.ssh/id_rsa /tmp/x").action).toBe("deny");
    expect(bash(root, `echo x > ${outsidePath("f").replace(/\\/g, "/")}`).rule).toBe("write-outside-project");
    expect(bash(root, "echo x > .agent-fence.toml").rule).toBe("protect-fence");
    expect(bash(root, "cd sub && cat ../.env").action).toBe("deny");
  });

  it("asks when the command cannot be parsed", () => {
    const { root } = sandbox();
    const d = bash(root, "echo 'unterminated");
    expect(d.action).toBe("ask");
    expect(d.rule).toBe("unparsable");
  });

  it("flags credential-looking strings", () => {
    const { root } = sandbox();
    expect(bash(root, "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://api").rule).toBe("secret-in-input");
    const p = loadPolicy({ cwd: root });
    expect(evaluate(p, { tool: "write", path: "a.ts", content: "const k = 'AKIAABCDEFGHIJKLMNOP'", cwd: root }).rule).toBe("secret-in-input");
  });

  it("guards paths for read and write tools", () => {
    const { root } = sandbox();
    const p = loadPolicy({ cwd: root });
    expect(evaluate(p, { tool: "read", path: ".env", cwd: root }).action).toBe("deny");
    expect(evaluate(p, { tool: "read", path: ".env.example", cwd: root }).action).toBe("allow");
    expect(evaluate(p, { tool: "read", path: "~/.ssh/id_ed25519", cwd: root }).action).toBe("deny");
    expect(evaluate(p, { tool: "write", path: "src/a.ts", cwd: root }).action).toBe("allow");
    expect(evaluate(p, { tool: "write", path: outsidePath("x.txt"), cwd: root }).rule).toBe("write-outside-project");
    expect(evaluate(p, { tool: "write", path: "/dev/null", cwd: root }).action).toBe("allow");
  });
});

describe("precedence", () => {
  it("the most specific match wins", () => {
    const { root } = sandbox({
      project: `
[[rules]]
id = "git-any"
action = "ask"
command = "git"
reason = "r"

[[rules]]
id = "git-status"
action = "allow"
command = "git status"
reason = "r"
`,
    });
    expect(bash(root, "git status").rule).toBe("git-status");
    expect(bash(root, "git log").rule).toBe("git-any");
  });

  it("deny wins a specificity tie", () => {
    const { root } = sandbox({
      project: `
[[rules]]
id = "a-allow"
action = "allow"
command = "make deploy"
reason = "r"

[[rules]]
id = "b-deny"
action = "deny"
command = "make deploy"
reason = "r"

[[rules]]
id = "c-ask"
action = "ask"
command = "make deploy"
reason = "r"
`,
    });
    expect(bash(root, "make deploy").rule).toBe("b-deny");
  });

  it("priority lifts a less specific rule", () => {
    const { root } = sandbox({
      project: `
[[rules]]
id = "all-make"
action = "deny"
command = "make"
priority = 100
reason = "r"

[[rules]]
id = "make-test"
action = "allow"
command = "make test"
reason = "r"
`,
    });
    expect(bash(root, "make test").rule).toBe("all-make");
  });

  it("a project rule may override a built-in by id or disable it", () => {
    const { root } = sandbox({
      project: `
disable = ["package-install"]

[[rules]]
id = "git-push"
action = "allow"
command = "git push"
reason = "pushing is fine here"
`,
    });
    expect(bash(root, "npm install x").action).toBe("allow");
    expect(bash(root, "git push").action).toBe("allow");
  });

  it("a project policy cannot loosen the user policy or locked rules", () => {
    const user = `
[[rules]]
id = "no-curl"
action = "deny"
command = "curl"
reason = "user says no"
`;
    const { root } = sandbox({
      user,
      project: `
[[rules]]
id = "curl-ok"
action = "allow"
command = "curl https://example.com"
reason = "trying to sneak past"
`,
    });
    expect(bash(root, "curl https://example.com").rule).toBe("no-curl");
    const s2 = sandbox({ user, project: `disable = ["no-curl"]` });
    expect(() => loadPolicy({ cwd: s2.root })).toThrow(PolicyError);
    const s3 = sandbox({ project: `disable = ["protect-fence"]` });
    expect(() => loadPolicy({ cwd: s3.root })).toThrow(/locked/);
  });

  it("the user policy may change built-ins", () => {
    const { root } = sandbox({ user: `disable = ["git-push"]` });
    expect(bash(root, "git push").action).toBe("allow");
  });

  it("strictest simple command decides a chain", () => {
    const { root } = sandbox();
    expect(bash(root, "git status && git push && git push --force").action).toBe("deny");
  });

  it("flags match in any order and inside clusters", () => {
    const { root } = sandbox({
      project: `
[[rules]]
id = "no-clean"
action = "deny"
command = "git clean -f -d"
reason = "r"
`,
    });
    for (const c of ["git clean -fd", "git clean -df", "git clean -d -f", "git clean -x -f -d"]) expect(bash(root, c).rule, c).toBe("no-clean");
    expect(bash(root, "git clean -n").rule).not.toBe("no-clean");
  });

  it("falls back to [defaults]", () => {
    const { root } = sandbox({ project: `[defaults]\nbash = "ask"\n` });
    const d = bash(root, "ls");
    expect(d.action).toBe("ask");
    expect(d.rule).toBe("default");
  });

  it("rejects invalid policy files with a clear message", () => {
    const bad = [
      ["[[rules]]\nid='x'\naction='nope'\ncommand='a'\nreason='r'", /action must be/],
      ["[[rules]]\nid='x'\naction='deny'\nreason='r'", /needs a matcher/],
      ["[[rules]]\nid='x'\naction='deny'\ncommand='a'", /reason is required/],
      ["[[rules]]\nid='x'\naction='deny'\ncommand='a'\npath='b'\nreason='r'", /one matcher/],
      ["[[rule]]\nid='x'", /unknown top-level key "rule"/],
      ["[[rules]]\nid='x'\naction='deny'\ncommand='a'\nreason='r'\ncolour='red'", /unknown key "colour"/],
    ] as const;
    for (const [text, msg] of bad) {
      const { root } = sandbox({ project: text });
      expect(() => loadPolicy({ cwd: root }), text).toThrow(msg);
    }
  });
});
