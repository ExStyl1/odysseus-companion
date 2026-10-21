/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync, rmSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

// bin/codex holds fetched codex-app-server binaries (gitignored, ~200MB each,
// possibly stale from earlier flagged builds). The packaged app receives codex
// only via the flag-gated electron-builder include into app/resources; the
// dist/resources copy is a runtime fallback that never wins, so copying the
// binaries here would smuggle them into every build regardless of the flag.
const codexBinDir = join(srcDir, "bin", "codex");

if (existsSync(srcDir)) {
  rmSync(destDir, { recursive: true, force: true });
  cpSync(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (source) => !source.startsWith(codexBinDir),
  });
  console.log("📦 Copied resources to dist (bin/codex excluded)");
} else {
  console.log("⚠️ No resources directory found");
}
