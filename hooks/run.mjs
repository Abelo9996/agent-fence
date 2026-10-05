#!/usr/bin/env node
// Runs the agent-fence CLI for a Claude Code plugin hook, with no install step.
//
// A global install (`npm install -g @abelo9996/agent-fence`) is used when one is on
// PATH, which costs about 0.1 s per hook call. Otherwise the CLI runs through
// `npx -y @abelo9996/agent-fence`, which costs about 0.4 s per call once npx has
// cached the package (the first call downloads it). Hook input on stdin, output on
// stdout and stderr, and the exit code all pass through unchanged.
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const PKG = "@abelo9996/agent-fence";
const BIN = "agent-fence";
const WIN = process.platform === "win32";

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The globally installed CLI as [command, args], or null. Skips npx's temporary shims. */
function globalInstall() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || /[\\/]_npx[\\/]/.test(dir)) continue;
    if (WIN) {
      // npm on Windows puts .cmd shims and node_modules side by side in its prefix.
      const script = path.join(dir, "node_modules", ...PKG.split("/"), "dist", "cli.js");
      if (isFile(path.join(dir, `${BIN}.cmd`)) && isFile(script)) return [process.execPath, [script]];
    } else {
      const bin = path.join(dir, BIN);
      if (!isFile(bin)) continue;
      let real = bin;
      try {
        real = realpathSync(bin);
      } catch {
        // keep the PATH entry
      }
      if (/[\\/]_npx[\\/]/.test(real)) continue;
      return [bin, []];
    }
  }
  return null;
}

const args = process.argv.slice(2);
const found = globalInstall();
const env = { ...process.env, AGENT_FENCE_VIA_PLUGIN: "1" };
// npx is a .cmd shim on Windows, which only a shell can start. The arguments are
// fixed words from hooks.json, so joining them into one command line is safe.
const command = found ? found[0] : "npx";
const child = found
  ? spawn(found[0], [...found[1], ...args], { stdio: "inherit", env })
  : WIN
    ? spawn(["npx", "-y", PKG, ...args].join(" "), { stdio: "inherit", env, shell: true })
    : spawn("npx", ["-y", PKG, ...args], { stdio: "inherit", env });
child.on("error", (e) => {
  process.stderr.write(`agent-fence plugin: could not run ${command} (${e.message}). Install Node 20+ or run: npm install -g ${PKG}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
