/**
 * Mock filesystem helper for tests.
 * Creates an in-memory mock for the `fs` module using vitest's vi.mock.
 * Call `setupMockFs()` before importing the module under test.
 * Use `getMockFs()` to inspect the written files after each test.
 */

import { vi } from "vitest";

const _files = new Map();

function reset() {
  _files.clear();
}

function existsSync(p) {
  return _files.has(p);
}

function readFileSync(p, enc) {
  const content = _files.get(p);
  if (content === undefined) {
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }
  return enc === "utf8" ? content : content;
}

function writeFileSync(p, data) {
  _files.set(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function mkdirSync(p, opts) {
  if (!_files.has(p)) {
    _files.set(p, "__dir__");
  }
}

function appendFileSync(p, data) {
  const existing = _files.get(p) || "";
  _files.set(p, existing + data);
}

/**
 * Set up a mock fs module via vitest's vi.mock.
 * Call this at the top of your test file, before any imports.
 */
export function setupMockFs() {
  reset();
  vi.mock("fs", () => ({
    default: { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync },
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    appendFileSync,
  }));
}

/**
 * Pre-populate the mock filesystem with initial files.
 * @param {Record<string, string>} files - Map of filepath to content
 */
export function seedMockFs(files) {
  for (const [path, content] of Object.entries(files)) {
    _files.set(path, content);
  }
}

/**
 * Get all files currently written to the mock filesystem.
 * @returns {Record<string, string>}
 */
export function getMockFs() {
  const result = {};
  for (const [path, content] of _files) {
    if (content !== "__dir__") {
      result[path] = content;
    }
  }
  return result;
}

/**
 * Get the content of a specific file from the mock filesystem.
 */
export function readMockFile(path) {
  return _files.get(path);
}

/**
 * Reset the mock filesystem (call in beforeEach).
 */
export function resetMockFs() {
  _files.clear();
}
