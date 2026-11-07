import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../repo-root.js";

export interface CheckSyntaxOptions {
  dir?: string;
}

export function checkSyntax(options: CheckSyntaxOptions = {}): boolean {
  const rootDir = options.dir ?? REPO_ROOT;
  let hasErrors = false;

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "logs"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (/\.(?:js|cjs)$/.test(file)) {
        const result: SpawnSyncReturns<string> = spawnSync(process.execPath, ["--check", file], {
          encoding: "utf8",
        });
        if (result.status !== 0) {
          process.stderr.write(result.stderr || String(result.error ?? `Syntax error in ${file}`));
          process.exitCode = 1;
          hasErrors = true;
        }
      }
    }
  }

  walk(rootDir);
  return !hasErrors;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  checkSyntax();
}
