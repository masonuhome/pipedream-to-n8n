// Shared by the CLI commands: the hosted service URL and reading an export from disk.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { unzip, type VirtualFile } from "./core/report";

export const VERSION = "0.2.0";
export const SERVICE = process.env.WORKFLOW_EXIT_URL ?? "https://workflowexit.com";

/** Files of an export ZIP, a folder (GitHub Sync repo, pulled JSON) or single files, as the loader expects them. */
export function readInput(paths: string[]): { files: VirtualFile[]; name: string } {
  const files: VirtualFile[] = [];
  const walk = (dir: string, base: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, base);
      else if (/\.(json|ya?ml|js|mjs|cjs|py|sh|go)$|\.workflow\.state$/i.test(name)) {
        files.push({ path: relative(base, p).split(sep).join("/"), text: readFileSync(p, "utf8") });
      }
    }
  };
  for (const p of paths) {
    const abs = resolve(p);
    if (statSync(abs).isDirectory()) walk(abs, abs);
    else if (/\.zip$/i.test(abs)) files.push(...unzip(new Uint8Array(readFileSync(abs))));
    else files.push({ path: basename(abs), text: readFileSync(abs, "utf8") });
  }
  const name = basename(resolve(paths[0])).replace(/\.zip$/i, "").replace(/^project_export-/, "");
  return { files, name };
}
