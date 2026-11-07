import "./envcrypt.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The standalone wallet-triggered bot is the app — there is no mode toggle.
// Entries come only via smart-wallet convergence; the LLM/server-driven
// flow lives on the `legacy` branch.

export function isMainExecution(metaUrl: string): boolean {
  const entry = process.env.pm_exec_path || process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainExecution(import.meta.url)) {
  const { startStandalone } = await import("./standalone/runtime.js");
  await startStandalone();
}
