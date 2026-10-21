/**
 * The managed-session-partition contract.
 *
 * Chromium proxy rules are per-`Session`. A partition that nobody configures
 * egresses direct, so in a proxy-only deployment it is a feature that fails
 * while the rest of the app works — which is exactly how the update feed
 * bypassed the proxy before session-partitions.ts existed.
 *
 * These tests are deliberately written against the SOURCE TREE rather than
 * against the two partitions we happen to know about today: a third
 * `session.fromPartition(...)` added anywhere under `apps/electron/src/main`
 * fails here until it is registered.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NET_SESSION_NAME } from 'electron-updater/out/electronHttpExecutor';
import {
  BROWSER_PANE_SESSION_PARTITION,
  MANAGED_SESSION_PARTITIONS,
  PAGE_THUMBNAIL_PARTITION,
  UPDATER_SESSION_PARTITION,
} from '../session-partitions';

const MAIN_DIR = join(import.meta.dir, '..');
const REGISTRY_FILE = join(MAIN_DIR, 'session-partitions.ts');

/** Every non-test `.ts` file under apps/electron/src/main. */
function mainSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...mainSourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Partition expressions used at a `session.fromPartition(<expr>)` call site or
 * as a `partition: <expr>` web-preferences property. Comments are stripped
 * first: a docblock names the seam in prose (`session.fromPartition(...)`),
 * which is not a call site (measured on `page-thumbnailer.ts`, UA7.4's
 * instrument trip).
 */
function partitionExpressions(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const found: string[] = [];
  for (const match of code.matchAll(/fromPartition\(\s*([^,)]+)/g)) {
    found.push(match[1]!.trim());
  }
  for (const match of code.matchAll(/(?<![\w.])partition:\s*([^,\n}]+)/g)) {
    found.push(match[1]!.trim());
  }
  return found;
}

describe('managed session partitions', () => {
  it('the registry is the only place a partition name is written down', () => {
    // A bare string at a fromPartition/partition site is a partition that the
    // proxy pass cannot see. Names must come from session-partitions.ts, which
    // is also the list configureElectronProxy walks.
    const registryExports = ['BROWSER_PANE_SESSION_PARTITION', 'UPDATER_SESSION_PARTITION', 'PAGE_THUMBNAIL_PARTITION'];
    const offenders: string[] = [];

    for (const file of mainSourceFiles(MAIN_DIR)) {
      if (file === REGISTRY_FILE) continue;
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

      // Local aliases of a registry export (`const SESSION_PARTITION = BROWSER_PANE_…`)
      // count as the export they were assigned from.
      const aliases = new Set<string>();
      for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\b/g)) {
        if (registryExports.includes(match[2]!)) aliases.add(match[1]!);
      }

      // A TYPE SIGNATURE reads like a call site to the regexes: an interface's
      // `fromPartition(partition: string): Session` captures `partition: string`
      // (a typed parameter — never a partition name) and then `string): Session`
      // for the property regex (a signature tail). And a FORWARDING PARAMETER —
      // `index.ts` wires the thumbnailer's seam as
      // `fromPartition: partition => …fromPartition(partition)` — holds whatever
      // the call site that CHOOSES the name passes; that site
      // (`page-thumbnailer.ts`) is judged here with the registry export in its
      // hand. Both shapes are UA7.4's, measured 2026-10-10; neither writes a
      // partition NAME down.
      const parameters = new Set<string>();
      // `[ \t]`, not `\s`: the prefix must not cross a newline, or `,` + the NEXT
      // line's `name:` matches as one and eats the arrow parameter after it.
      for (const match of code.matchAll(/[:(,][ \t]*(\w+)[ \t]*(?:=>|:)/g)) {
        parameters.add(match[1]!);
      }
      const isTypeSignature = (expression: string): boolean =>
        // Exactly `param: Type` — the fromPartition regex's read of a typed
        // parameter. Anchored both ends so a quoted partition NAME that
        // contains a colon (`partition: 'persist:x'` — a real offender) can
        // never ride it.
        /^\w+:[ \t]*\w+$/.test(expression)
        || (expression.includes(')') && !/\w\(/.test(expression))
        || expression === '...';

      for (const expression of partitionExpressions(source)) {
        const known = registryExports.includes(expression)
          || aliases.has(expression)
          || parameters.has(expression)
          || isTypeSignature(expression)
          || expression.startsWith('managed.partition');
        if (!known) {
          offenders.push(`${file.slice(MAIN_DIR.length + 1)}: ${expression}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every partition constant the registry exports is registered for configuration', () => {
    // Declaring a partition without listing it in MANAGED_SESSION_PARTITIONS
    // would create a session nothing configures.
    const source = readFileSync(REGISTRY_FILE, 'utf8');
    const declared = [...source.matchAll(/export const (\w*SESSION_PARTITION\w*)\b/g)]
      .map(match => match[1]!)
      .filter(name => name !== 'MANAGED_SESSION_PARTITIONS');

    const registered = MANAGED_SESSION_PARTITIONS.map(entry => entry.partition);
    const values: Record<string, string> = {
      BROWSER_PANE_SESSION_PARTITION,
      UPDATER_SESSION_PARTITION,
      PAGE_THUMBNAIL_PARTITION,
    };

    for (const name of declared) {
      expect(values[name]).toBeDefined();
      expect(registered).toContain(values[name]!);
    }
    // The default session has no name and must stay in the list.
    expect(registered).toContain(null);
  });

  it('takes the updater partition from electron-updater rather than copying the string', () => {
    // Read back from the installed package: an upgrade that renames the
    // partition fails here instead of silently reverting the update feed to an
    // unconfigured session.
    expect(UPDATER_SESSION_PARTITION).toBe(NET_SESSION_NAME);

    // The updater creates its session uncached; configuring it first must not
    // hand the updater a cached session instead.
    const updater = MANAGED_SESSION_PARTITIONS.find(e => e.partition === UPDATER_SESSION_PARTITION);
    expect(updater?.options).toEqual({ cache: false });
  });
});
