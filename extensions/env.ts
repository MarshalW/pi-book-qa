/**
 * Shared environment loader.
 *
 * Resolution order:
 * 1. Walk up from the given startDir (usually ctx.cwd) until the git root
 *    (inclusive), checking each level for a `.env` file.
 * 2. Fall back to the package root (one level above extensions/).
 *
 * First `.env` found wins; missing files are skipped silently.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const MAX_UPLEVELS = 10;

export function loadEnvFrom(startDir: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Candidate directories, in priority order.
  const dirs: string[] = [];

  // 1. Walk up from startDir to the git root (or filesystem root).
  let cur = startDir;
  for (let i = 0; i < MAX_UPLEVELS; i++) {
    dirs.push(cur);
    if (existsSync(join(cur, ".git"))) break;
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root reached
    cur = parent;
  }

  // 2. Package root fallback (for a .env shipped next to the package).
  dirs.push(join(HERE, ".."));

  for (const dir of dirs) {
    try {
      const text = readFileSync(join(dir, ".env"), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] ??= m[2].replace(/^['"]|['"]$/g, "");
      }
      if (Object.keys(out).length > 0) break;
    } catch {
      // .env not found at this level — try next
    }
  }
  return out;
}
