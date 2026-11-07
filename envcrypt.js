import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { repoPath } from "./repo-root.js";

const DEFAULT_ENV_PATH = repoPath(".env");
const DEFAULT_KEY_PATH = repoPath(".envrypt");

function isEncryptedMarker(line) {
  return line.trim().toLowerCase() === "# encrypted";
}

function parseEncryptedKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set();

  const encrypted = new Set();
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
    if (match && encryptedNext) encrypted.add(match[1]);
    encryptedNext = false;
  }
  return encrypted;
}

function getEnvcryptKey(keyPath = DEFAULT_KEY_PATH) {
  const key =
    process.env.ENVRYPT_KEY ||
    process.env.ENVCRYPT_KEY ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

  if (!key) return null;
  if (key.length < 8) {
    throw new Error("Envrypt encryption key must be at least 8 characters long.");
  }
  return key;
}

function shouldEncryptEnvKey(envKey) {
  return envKey.endsWith("_KEY") ||
    envKey.startsWith("ENVRIPT_") ||
    /(?:PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC)/i.test(envKey);
}

export function envryptEncrypt(value, key) {
  const valBuf = Buffer.from(String(value), "utf8");
  const keyBuf = Buffer.from(String(key), "utf8");
  const out = Buffer.alloc(valBuf.length);
  for (let i = 0; i < valBuf.length; i++) {
    out[i] = valBuf[i] ^ keyBuf[i % keyBuf.length];
  }
  return out.toString("base64");
}

export function envryptDecrypt(value, key) {
  const encBuf = Buffer.from(String(value), "base64");
  const keyBuf = Buffer.from(String(key), "utf8");
  const out = Buffer.alloc(encBuf.length);
  for (let i = 0; i < encBuf.length; i++) {
    out[i] = encBuf[i] ^ keyBuf[i % keyBuf.length];
  }
  return out.toString("utf8");
}

export function loadEnv({ envPath = DEFAULT_ENV_PATH, keyPath = DEFAULT_KEY_PATH, override = true } = {}) {
  // override=true so repo .env wins over stale PM2-injected env on restart
  dotenv.config({ path: envPath, override, quiet: true });

  const encryptedKeys = parseEncryptedKeys(envPath);
  if (encryptedKeys.size === 0) return { encryptedKeys: [] };

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error(
      `Encrypted env values found in ${envPath}, but no envrypt key was provided. ` +
      "Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY.",
    );
  }

  for (const envKey of encryptedKeys) {
    const value = process.env[envKey];
    if (value == null || value === "") continue;
    process.env[envKey] = envryptDecrypt(value, key);
  }

  return { encryptedKeys: [...encryptedKeys] };
}

export function encryptEnvRaw({
  rawPath = repoPath(".env.raw"),
  outPath = DEFAULT_ENV_PATH,
  keyPath = DEFAULT_KEY_PATH,
} = {}) {
  if (!fs.existsSync(rawPath)) {
    throw new Error(`No ${rawPath} file found.`);
  }

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error("Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY before encrypting.");
  }

  const parsed = dotenv.parse(fs.readFileSync(rawPath, "utf8"));
  const lines = ["# Envrypt managed environment file.", ""];
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
