import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/shell.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  shims: false,
});
