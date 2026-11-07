#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptEnvRaw, envryptDecrypt } from "../envcrypt.js";

export function usage(): void {
  console.log(`Usage:
  node scripts/envrypt.js encrypt [rawPath] [outPath]
  node scripts/envrypt.js decrypt KEY VALUE

  Envrypt key read from .envrypt, ENVRYPT_KEY, or ENVCRYPT_KEY.`);
}

export function runCli(argv: string[] = process.argv.slice(2)): void {
  const [command, first, second] = argv;

  try {
    if (command === "encrypt") {
      const result = encryptEnvRaw({
        rawPath: first || undefined,
        outPath: second || undefined,
      });
      console.log(`Encrypted ${result.rawPath} -> ${result.outPath}`);
    } else if (command === "decrypt") {
      if (!first || !second) {
        usage();
        process.exit(1);
      }
      console.log(envryptDecrypt(second, first));
    } else {
      usage();
      process.exit(command ? 1 : 0);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli();
}
