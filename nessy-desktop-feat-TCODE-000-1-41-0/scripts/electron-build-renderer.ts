#!/usr/bin/env bun
/**
 * Cross-platform renderer build script — and the one gate that keeps the
 * renderer graph free of main-process code.
 *
 * ## Why this script refuses on a WARNING (P6.981)
 *
 * `apps/electron/vite.config.ts`'s header states the standing rule in its own
 * words: *"the renderer build must print **zero** `has been externalized for
 * browser compatibility` warnings. It printed 282 before P6.971 and 0 after. A
 * warning returning means a shared module that touches Node is back in the
 * renderer graph, and the hard error is one named import behind it."*
 *
 * Nothing enforced that rule. What makes it worth enforcing is P6.971's whole
 * cost: in a production build every browser-externalized node builtin resolves
 * to one stub module whose body is `export default {}`, so a DEFAULT or
 * namespace import of a builtin is only this warning while a NAMED import is a
 * hard rollup error — and rollup aborts at the FIRST one and says nothing about
 * the rest. 175 such errors sat queued behind a single edge, invisible until a
 * nine-minute packaged build died on one of them.
 *
 * The warning is therefore the LEADING INDICATOR of the error, it is free, and
 * its true count is zero — which is the only reason a zero-tolerance pin is
 * honest here. A renderer that needs a builtin has taken a wrong turn; the fix
 * belongs in the source (P6.971 cut one edge for two constants), not in a
 * threshold here.
 *
 * The scan reads the child's stdout AND stderr, because which stream a vite
 * logger warning lands on is not a contract this repo controls, and it strips
 * ANSI colour before matching for the same reason.
 */

import { spawn } from "bun";
import { existsSync, rmSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

/** Vite's own wording. Quoted in `vite.config.ts`'s header and pinned by the test. */
export const EXTERNALIZED_MARKER = "has been externalized for browser compatibility";

export interface ExternalizedWarning {
  /** The module vite externalized, or the whole line when it does not name one. */
  readonly module: string;
  /** The importer vite blames, when the line carries one. */
  readonly importer: string | undefined;
}

/** A CSI escape — vite colours its warnings, and a colour run can sit mid-sentence. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * Every externalization warning in a build's output, in the order vite printed
 * them. Pure, so the test can plant a warning rather than depend on a build.
 *
 * A line carrying the marker but not vite's `Module "X"` shape is reported with
 * the raw line as its module: a warning this parser cannot read must not be
 * dropped silently, which is the direction that would make the gate quiet.
 */
export function findExternalizedWarnings(output: string): ExternalizedWarning[] {
  const out: ExternalizedWarning[] = [];
  for (const raw of output.replace(ANSI, "").split("\n")) {
    if (!raw.includes(EXTERNALIZED_MARKER)) continue;
    const named = /Module "([^"]+)" has been externalized/.exec(raw);
    const importer = /imported by "([^"]+)"/.exec(raw);
    out.push({ module: named?.[1] ?? raw.trim(), importer: importer?.[1] });
  }
  return out;
}

/** The refusal, as one string — exported so the test reads what a developer would. */
export function externalizedRefusal(warnings: readonly ExternalizedWarning[]): string {
  const seen = new Map<string, string | undefined>();
  for (const warning of warnings) {
    if (!seen.has(warning.module)) seen.set(warning.module, warning.importer);
  }
  return [
    `electron:build:renderer REFUSED: ${warnings.length} "${EXTERNALIZED_MARKER}" warning(s) `
      + `over ${seen.size} module(s). The renderer graph has re-acquired main-process code.`,
    ...[...seen].map(
      ([module, importer]) => `  ${module}${importer === undefined ? "" : `  <- ${importer}`}`,
    ),
    "",
    "This is the LEADING INDICATOR, not the failure: a default or namespace import of a node",
    "builtin is only this warning, while a NAMED import of the same builtin is a hard rollup",
    "error — and rollup aborts at the first one, so the rest stay invisible until a packaged",
    "build dies minutes in. 175 sat queued behind one edge before P6.971.",
    "",
    "Fix it in the SOURCE: find the module above in the renderer's import graph and cut the",
    "edge, or split the Node-touching half out of the shared module (P6.971 moved two",
    "constants into config/cross-session-inbound-vocabulary.ts for exactly this). The rule",
    "and its readings are in apps/electron/vite.config.ts's header.",
  ].join("\n");
}

/** Copy a child stream to `sink` as it arrives AND return everything it carried. */
async function tee(stream: ReadableStream<Uint8Array>, sink: Bun.BunFile): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    await Bun.write(sink, chunk);
  }
  return text + decoder.decode();
}

async function main(): Promise<number> {
  // Clean renderer dist first
  const rendererDir = join(ELECTRON_DIR, "dist/renderer");
  if (existsSync(rendererDir)) {
    rmSync(rendererDir, { recursive: true, force: true });
  }

  const proc = spawn({
    cmd: ["bun", "run", "vite", "build", "--config", "apps/electron/vite.config.ts"],
    cwd: ROOT_DIR,
    // Piped rather than inherited so the warnings can be READ. Both streams are
    // copied through as they arrive, so the build still looks live.
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
  });

  const [stdout, stderr] = await Promise.all([
    tee(proc.stdout, Bun.stdout),
    tee(proc.stderr, Bun.stderr),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) return exitCode;

  const warnings = findExternalizedWarnings(`${stdout}\n${stderr}`);
  if (warnings.length > 0) {
    console.error(externalizedRefusal(warnings));
    return 1;
  }
  return 0;
}

// Behind `import.meta.main` so importing the two pure functions for the test runs
// no build and can never reach the `process.exit` below: a module body that exits
// kills the test runner at IMPORT time and reports exit 0 with ZERO tests
// executed (AGENTS.md §Traps).
if (import.meta.main) process.exit(await main());
