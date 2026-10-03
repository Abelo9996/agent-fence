import { symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../src/engine.js";
import { loadPolicy } from "../src/policy.js";
import { normalizePath, toPosix } from "../src/paths.js";
import { cleanup, sandbox, write } from "./helpers.js";

afterEach(cleanup);

describe("normalizePath", () => {
  it("resolves relative paths, .. and ~", () => {
    const { root, home } = sandbox();
    const r = toPosix(root);
    expect(normalizePath("a/b/../c.txt", root)).toBe(`${r}/a/c.txt`);
    expect(normalizePath("./a//b/", root)).toBe(`${r}/a/b`);
    expect(normalizePath("~/x", root)).toBe(`${toPosix(home)}/x`);
    expect(normalizePath("$HOME/x", root)).toBe(`${toPosix(home)}/x`);
  });

  it("treats backslashes as separators", () => {
    const { root } = sandbox();
    expect(normalizePath("a\\b\\..\\c.txt", root)).toBe(`${toPosix(root)}/a/c.txt`);
    expect(normalizePath("C:\\Users\\me\\..\\x\\.env", "C:\\proj", { resolveSymlinks: false })).toBe("C:/Users/x/.env");
  });

  it.skipIf(process.platform === "win32")("resolves symlinks, including for files that do not exist yet", () => {
    const { root, home } = sandbox();
    write(home, "secrets/.keep", "");
    symlinkSync(path.join(home, "secrets"), path.join(root, "link"));
    expect(normalizePath("link/new.txt", root)).toBe(`${toPosix(home)}/secrets/new.txt`);
  });
});

describe("path rules", () => {
  it("cannot be dodged with .., ~, backslashes or symlinks", () => {
    const { root, home } = sandbox();
    write(home, ".ssh/id_ed25519", "k");
    const p = loadPolicy({ cwd: root });
    const read = (q: string) => evaluate(p, { tool: "read", path: q, cwd: root }).action;
    expect(read("sub/../.env")).toBe("deny");
    expect(read("sub\\..\\.env")).toBe("deny");
    expect(read("~/.ssh/id_ed25519")).toBe("deny");
    expect(read(path.join(home, ".ssh", "id_ed25519"))).toBe("deny");
    expect(read("deploy/prod.pem")).toBe("deny");
    if (process.platform !== "win32") {
      symlinkSync(path.join(home, ".ssh"), path.join(root, "innocent"));
      expect(read("innocent/id_ed25519")).toBe("deny");
    }
  });

  it("matches relative patterns from the project root", () => {
    const { root } = sandbox({
      project: `
[[rules]]
id = "no-migrations"
action = "ask"
tool = "write"
path = "db/migrations/**"
reason = "r"
`,
    });
    const p = loadPolicy({ cwd: root });
    expect(evaluate(p, { tool: "write", path: "db/migrations/001.sql", cwd: root }).rule).toBe("no-migrations");
    expect(evaluate(p, { tool: "write", path: "../migrations/001.sql", cwd: path.join(root, "db", "x") }).rule).toBe("no-migrations");
    expect(evaluate(p, { tool: "read", path: "db/migrations/001.sql", cwd: root }).action).toBe("allow");
  });
});
