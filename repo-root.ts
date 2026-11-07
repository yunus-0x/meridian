import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Meridian repo root — stable under PM2, npm start, and CLI. */
export const REPO_ROOT: string = __dirname;

export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}
