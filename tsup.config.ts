import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  // One file to download: the lazily imported convert command is inlined, not split into a chunk.
  splitting: false,
  // One self-contained file: the report/analysis code and its dependencies are bundled.
  noExternal: ["yaml", "fflate", "acorn", "acorn-walk"],
  // yaml's CJS build calls require(); give the ESM bundle a real one.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  clean: true,
  minify: false,
});
