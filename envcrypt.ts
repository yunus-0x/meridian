import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";
import { repoPath } from "./repo-root.js";

const DEFAULT_ENV_PATH = repoPath(".env");
const DEFAULT_KEY_PATH = repoPath(".envrypt");

export const EnvcryptFileKeySchema = z
  .string()
  .min(8, "Envrypt encryption key must be at least 8 characters long.");

export const EnvcryptKeySchema = z.string().min(1, "Encryption key cannot be empty.");

export const EnvcryptValueSchema = z.union([z.string(), z.number()]);

export const LoadEnvOptionsSchema = z.object({
  envPath: z.string().optional(),
  keyPath: z.string().optional(),
  override: z.boolean().optional(),
});
export type LoadEnvOptions = z.infer<typeof LoadEnvOptionsSchema>;

export const EncryptEnvRawOptionsSchema = z.object({
  rawPath: z.string().optional(),
  outPath: z.string().optional(),
  keyPath: z.string().optional(),
});
export type EncryptEnvRawOptions = z.infer<typeof EncryptEnvRawOptionsSchema>;

export const ParsedEnvMapSchema = z.record(z.string(), z.string());

function isEncryptedMarker(line: string): boolean {
  return line.trim().toLowerCase() === "# encrypted";
}

function parseEncryptedKeys(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();

  const encrypted = new Set<string>();
  let encryptedNext = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      encryptedNext = false;
      continue;
    }
    if (isEncryptedMarker(trimmed)) {
      encryptedNext = true;
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && encryptedNext && match[1]) {
      encrypted.add(match[1]);
    }
    encryptedNext = false;
  }
  return encrypted;
}

function getEnvcryptKey(keyPath: string = DEFAULT_KEY_PATH): string | null {
  const key =
    process.env["ENVRYPT_KEY"] ||
    process.env["ENVCRYPT_KEY"] ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

  if (!key) return null;
  return EnvcryptFileKeySchema.parse(key);
}

function shouldEncryptEnvKey(envKey: string): boolean {
  return (
    envKey.endsWith("_KEY") ||
    envKey.startsWith("ENVRIPT_") ||
    /(?:PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC)/i.test(envKey)
  );
}

export function envryptEncrypt(value: string | number, key: string): string {
  const validValue = EnvcryptValueSchema.parse(value);
  const validKey = EnvcryptKeySchema.parse(key);
  const valBuf = Buffer.from(String(validValue), "utf8");
  const keyBuf = Buffer.from(validKey, "utf8");
  const out = Buffer.alloc(valBuf.length);
  for (let i = 0; i < valBuf.length; i++) {
    const v = valBuf[i] ?? 0;
    const k = keyBuf[i % keyBuf.length] ?? 0;
    out[i] = v ^ k;
  }
  return out.toString("base64");
}

export function envryptDecrypt(value: string, key: string): string {
  const validValue = z.string().parse(value);
  const validKey = EnvcryptKeySchema.parse(key);
  const encBuf = Buffer.from(validValue, "base64");
  const keyBuf = Buffer.from(validKey, "utf8");
  const out = Buffer.alloc(encBuf.length);
  for (let i = 0; i < encBuf.length; i++) {
    const e = encBuf[i] ?? 0;
    const k = keyBuf[i % keyBuf.length] ?? 0;
    out[i] = e ^ k;
  }
  return out.toString("utf8");
}

export interface LoadEnvResult {
  encryptedKeys: string[];
}

export function loadEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const opts = LoadEnvOptionsSchema.parse(options);
  const envPath = opts.envPath ?? DEFAULT_ENV_PATH;
  const keyPath = opts.keyPath ?? DEFAULT_KEY_PATH;
  const override = opts.override ?? true;
  // override=true so repo .env wins over stale PM2-injected env on restart
  dotenv.config({ path: envPath, override, quiet: true });

  const encryptedKeys = parseEncryptedKeys(envPath);
  if (encryptedKeys.size === 0) return { encryptedKeys: [] };

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error(
      `Encrypted env values found in ${envPath}, but no envrypt key was provided. ` +
      "Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY."
    );
  }

  for (const envKey of encryptedKeys) {
    const value = process.env[envKey];
    if (value == null || value === "") continue;
    process.env[envKey] = envryptDecrypt(value, key);
  }

  return { encryptedKeys: [...encryptedKeys] };
}

export interface EncryptEnvRawResult {
  rawPath: string;
  outPath: string;
}

export function encryptEnvRaw(options: EncryptEnvRawOptions = {}): EncryptEnvRawResult {
  const opts = EncryptEnvRawOptionsSchema.parse(options);
  const rawPath = opts.rawPath ?? repoPath(".env.raw");
  const outPath = opts.outPath ?? DEFAULT_ENV_PATH;
  const keyPath = opts.keyPath ?? DEFAULT_KEY_PATH;

  if (!fs.existsSync(rawPath)) {
    throw new Error(`No ${rawPath} file found.`);
  }

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error("Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY before encrypting.");
  }

  const parsedRaw: unknown = dotenv.parse(fs.readFileSync(rawPath, "utf8"));
  const parsed = ParsedEnvMapSchema.parse(parsedRaw);
  const lines: string[] = ["# Envrypt managed environment file.", ""];
  for (const [envKey, value] of Object.entries(parsed)) {
    if (shouldEncryptEnvKey(envKey)) {
      lines.push("# encrypted");
      lines.push(`${envKey}=${envryptEncrypt(value, key)}`, "");
    } else {
      lines.push(`${envKey}=${value}`);
    }
  }

  fs.writeFileSync(outPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return { rawPath, outPath };
}

loadEnv();
