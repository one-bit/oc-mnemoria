import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    noExternal: ["@opencode-ai/plugin"],
  },
  {
    entry: ["src/plugin.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    outDir: "dist",
    noExternal: ["@opencode-ai/plugin"],
  },
]);
