/**
 * Patches @coral-xyz/anchor + @meteora-ag/dlmm for Node 24 ESM compatibility.
 *
 * Problem: Node 24 ESM doesn't support bare directory imports (e.g. "utils/bytes").
 * DLMM's index.mjs does: import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
 * ESM never extension-guesses, so it hits the bytes/ directory and throws.
 *
 * Fix 1: Add an exports map to anchor's package.json mapping each util dir to its index.js.
 * Fix 2: Directly rewrite the bare import in DLMM's index.mjs to use the explicit path.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// ─── Fix 1: Patch anchor's package.json exports ──────────────────────────────
const anchorPkgPath = path.join(root, "node_modules/@coral-xyz/anchor/package.json");
const anchorPkg = JSON.parse(fs.readFileSync(anchorPkgPath, "utf8"));
const anchorUtils = path.join(root, "node_modules/@coral-xyz/anchor/dist/cjs/utils");

if (!anchorPkg.exports) {
  const dirs = fs.readdirSync(anchorUtils, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  anchorPkg.exports = {
    // Always serve CJS — anchor's ESM dist has its own bare directory import bugs
    ".": {
      default: "./dist/cjs/index.js",
    },
    // Map each util directory to its explicit CJS index.js
    ...Object.fromEntries(
      dirs.map(dir => [
        `./dist/cjs/utils/${dir}`,
        `./dist/cjs/utils/${dir}/index.js`,
      ])
    ),
    // Allow any other direct file path through
    "./*": "./*",
  };

  fs.writeFileSync(anchorPkgPath, JSON.stringify(anchorPkg, null, 2));
  console.log("Patched: @coral-xyz/anchor/package.json exports");
} else {
  console.log("Skip: @coral-xyz/anchor exports already set");
}

// ─── Fix 2: Patch DLMM index.mjs bare directory imports ──────────────────────
const dlmmMjs = path.join(root, "node_modules/@meteora-ag/dlmm/dist/index.mjs");

if (fs.existsSync(dlmmMjs)) {
  let src = fs.readFileSync(dlmmMjs, "utf8");
  const original = src;

  // Replace all bare directory imports of anchor utils with explicit .js paths
  src = src.replace(
    /from ["'](@coral-xyz\/anchor\/dist\/cjs\/utils\/\w+)["']/g,
    (_, p) => `from "${p}/index.js"`
  );

  // Fix 3: ESM cannot find named export 'BN' from CommonJS anchor
  // We rewrite the imports to remove BN and then add a single top-level BN import.

  // Strip any existing `import BN from "bn.js"` lines (any quote style)
  src = src.replace(/^import BN from ["']bn\.js["'];\n/gm, "");
  // Also strip CJS-style BN re-exports that some bundle versions emit
  src = src.replace(/^var BN = require\(["']bn\.js["']\);\n/gm, "");
  src = src.replace(/^const BN = require\(["']bn\.js["']\);\n/gm, "");

  // Add exactly one canonical BN import at the top if BN is used anywhere
  if (src.includes('BN')) {
    src = 'import BN from "bn.js";\n' + src;
  }

  // Helper: remove BN or BN as alias from an import specifier list and clean up commas
  function removeBNFromSpecifiers(specifiers) {
    return specifiers
      .split(",")
      .map(s => s.trim())
      .filter(s => s && !/^BN(\s+as\s+\w+)?$/.test(s))
      .join(", ");
  }

  // Handle aliased BN imports: import { BN as BN18 } from "@coral-xyz/anchor";
  src = src.replace(
    /import \{([^}]*)\bBN as (\w+)\b([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, alias, after) => {
      const remaining = removeBNFromSpecifiers(before + "," + after);
      const anchorImport = remaining ? `import { ${remaining} } from "@coral-xyz/anchor";` : "";
      return `${anchorImport}\nconst ${alias} = BN;`;
    }
  );

  // Handle named BN imports: import { BN } from "@coral-xyz/anchor";
  src = src.replace(
    /import \{([^}]*)\bBN\b(?!\s*as\b)([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, after) => {
      const remaining = removeBNFromSpecifiers(before + "," + after);
      return remaining ? `import { ${remaining} } from "@coral-xyz/anchor";` : "";
    }
  );

  if (src !== original) {
    fs.writeFileSync(dlmmMjs, src);
    console.log("Patched: @meteora-ag/dlmm/dist/index.mjs directory imports");
  } else {
    console.log("Skip: @meteora-ag/dlmm/dist/index.mjs already patched");
  }
}
