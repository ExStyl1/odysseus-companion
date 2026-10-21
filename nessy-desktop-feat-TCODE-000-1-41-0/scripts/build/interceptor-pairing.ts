/**
 * The pairing the packaged headless server silently lacked.
 *
 * The network interceptor carries the OpenAI SSE tool-call consolidation, the
 * Nestor gateway request rewriting, rich tool intent, the fast-mode override and
 * `MalformedBodyError` validation. Until this module existed it reached the
 * server only through the repo-root `bunfig.toml` preload — and `bun` resolves
 * `bunfig.toml` from the CWD, never from the script path, so no assembled
 * distribution could inherit it. The shipped `nessy-server` therefore ran
 * without the interceptor while every `bun run` in the repo ran with it: a
 * dev-only feature masquerading as a shipped one.
 *
 * Two things have to hold, and nothing asserted either of them before:
 *   1. the interceptor bundle SHIPS inside the distribution, and
 *   2. the entry points LOAD it before any server code issues a request.
 *
 * `verifyInterceptorPairing` is that assertion, run against the assembled tree
 * at the end of every server build.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

/**
 * Path of the interceptor bundle inside the assembled distribution.
 *
 * `<dist>/dist/interceptor.cjs` mirrors the packaged Electron app's layout (app
 * root + `dist/interceptor.cjs`), which is exactly what
 * `resolveInterceptorBundlePath` (`agent/backend/internal/runtime-resolver.ts`)
 * probes in packaged mode. Shipping it here means the Pi subprocess the server
 * spawns picks it up through `--require` with no runtime-code change, while
 * `bin/nessy-server` preloads the same file into the server's own process.
 *
 * POSIX separator on purpose: the same string is interpolated into the shell
 * entry script. The server distribution targets darwin/linux only.
 */
export const INTERCEPTOR_BUNDLE_RELATIVE = 'dist/interceptor.cjs';

/** Message the interceptor logs when it installs — proves the bundle is the real thing. */
export const INTERCEPTOR_BUNDLE_MARKER = 'Unified fetch interceptor installed';

/**
 * The exact `bun run` fragment `bin/nessy-server` uses to preload the interceptor.
 *
 * Single source of truth for both halves of the pairing: the fragment is derived
 * from the same constant the bundle is written to, so the two cannot drift.
 * `--preload` must come after `run` — `bun --preload <file> run <entry>` is
 * rejected by the CLI.
 */
export function interceptorPreloadFragment(): string {
  return `--preload "$ROOT/${INTERCEPTOR_BUNDLE_RELATIVE}"`;
}

/**
 * Fail when ONE interceptor bundle is absent or is not the interceptor.
 *
 * Shared by both builds, which is the point: the server build asserted this and
 * the Electron build did not. `resolveInterceptorBundlePath`
 * (`agent/backend/internal/runtime-resolver.ts`) preloads the `.ts` source while
 * `!isPackaged` and `dist/interceptor.cjs` once packaged, and returns
 * `undefined` when the bundle is missing — so the packaged app's Pi subprocess
 * starts UNPATCHED with no error, and every dev run keeps working. Nothing at
 * runtime can catch that, and no live drive can either (the CDP wave runs in
 * `electron:dev`, which always loads the source). It is a build assertion, so it
 * is asserted at build time.
 *
 * The marker check is not belt-and-braces: an empty or truncated file passes an
 * existence check and ships exactly the same silent failure.
 *
 * @param bundlePath path of the interceptor bundle to assert
 * @param context what would ship broken, named in the failure
 * @throws when the bundle is absent or does not contain the interceptor
 */
export function verifyInterceptorBundle(bundlePath: string, context: string): void {
  if (!existsSync(bundlePath)) {
    throw new Error(
      `Interceptor bundle missing at ${bundlePath}. ${context} `
      + 'Restore the interceptor build step (`bun run build:interceptor`).',
    );
  }
  if (!readFileSync(bundlePath, 'utf-8').includes(INTERCEPTOR_BUNDLE_MARKER)) {
    throw new Error(
      `Interceptor bundle at ${bundlePath} does not contain the interceptor `
      + `(marker "${INTERCEPTOR_BUNDLE_MARKER}" not found). The bundle step produced the wrong file.`,
    );
  }
}

/** What the Electron build loses when `dist/interceptor.cjs` is absent. */
export const ELECTRON_INTERCEPTOR_CONTEXT =
  'The packaged app\'s Pi subprocess would start unpatched and with no error: no SSE '
  + 'tool-call consolidation, no Nestor header rewriting, no rich tool intent, no API '
  + 'error capture.';

/**
 * Fail the build when the distribution is assembled without the interceptor.
 *
 * @param outputDir root of the assembled server distribution
 * @throws when the bundle is absent, is not the interceptor, or is never loaded
 */
export function verifyInterceptorPairing(outputDir: string): void {
  const bundle = join(outputDir, INTERCEPTOR_BUNDLE_RELATIVE);
  verifyInterceptorBundle(
    bundle,
    'The packaged server would run without SSE tool-call consolidation, Nestor '
    + 'header rewriting and API error capture.',
  );

  const entryPath = join(outputDir, 'bin', 'nessy-server');
  const entry = existsSync(entryPath) ? readFileSync(entryPath, 'utf-8') : '';
  if (!entry.includes(interceptorPreloadFragment())) {
    throw new Error(
      `bin/nessy-server does not preload the interceptor (${interceptorPreloadFragment()}). `
      + 'The bundle would ship but never load into the server process.',
    );
  }

  const dockerfilePath = join(outputDir, 'Dockerfile');
  const dockerfile = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, 'utf-8') : '';
  if (!dockerfile.includes('ENTRYPOINT ["/app/bin/nessy-server"]')) {
    throw new Error(
      'Dockerfile ENTRYPOINT no longer routes through bin/nessy-server, so container '
      + 'deployments would bypass the interceptor preload.',
    );
  }
}

/** Where the interceptor and its import closure live, relative to the repo root. */
export const INTERCEPTOR_SRC_DIR = join('packages', 'shared', 'src');

/** The module every packaging path stages, and the root of the closure below. */
export const INTERCEPTOR_ENTRY = 'unified-network-interceptor.ts';

/**
 * Comments removed, so a specifier quoted in PROSE is not read as an import.
 *
 * Not decoration. `unified-network-interceptor.ts` carries a docblock that
 * quotes an import of `config/config-doctor.ts` while measuring what importing
 * it would cost (8 modules to 116, 76 KB to 666 KB). A text scan that keeps
 * comments derives a closure containing the one module this file deliberately
 * does NOT import. The line-comment pass leaves a `//` preceded by a colon
 * alone, so an `https:` URL inside a string survives.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Relative specifiers a module loads, in first-seen order.
 *
 * Matched on comment-stripped text rather than parsed: `from '…'` covers the
 * `import`, `import type`, `export … from` and multi-line forms alike (a
 * multi-line import's specifier sits on a line beginning with a brace, so a
 * line-anchored `^import` scan misses four of this module's own six), and the
 * second pattern covers the bare side-effect and dynamic `import('…')` forms.
 * Only relative specifiers matter: a bare one resolves through node_modules and
 * is not a file this staging step can copy.
 */
export function relativeImportsOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(?\s*['"]([^'"]+)['"]/g]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.') && !found.includes(specifier)) found.push(specifier);
    }
  }
  return found;
}

/** One relative specifier, resolved to a path under `INTERCEPTOR_SRC_DIR`. */
function resolveClosureMember(srcDir: string, importer: string, specifier: string): string {
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (target.startsWith('..')) {
    throw new Error(
      `Interceptor closure: ${importer} imports ${specifier}, which resolves outside `
      + `${INTERCEPTOR_SRC_DIR}. The staged tree has no root for it — stage it deliberately `
      + 'or drop the import.',
    );
  }
  const candidates = target.endsWith('.ts') ? [target] : [`${target}.ts`, posix.join(target, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(join(srcDir, ...candidate.split('/')))) return candidate;
  }
  throw new Error(
    `Interceptor closure: ${importer} imports ${specifier}, which resolves to no file under `
    + `${INTERCEPTOR_SRC_DIR}.`,
  );
}

/**
 * The interceptor's own import closure, DERIVED rather than hand-listed (P6.805).
 *
 * `copyInterceptor` and the three platform build scripts each carried the same
 * hand-written list of three — `interceptor-common.ts`, `feature-flags.ts`,
 * `interceptor-request-utils.ts` — while the module has five direct imports:
 * `auth/nestor.ts` and `telemetry/gateway-headers.ts` were missing from every
 * one of them, uniformly, so it was never a slip in one script. Walking the
 * imports transitively adds two more the hand list could not have named without
 * reading further: `config/paths.ts` (from `interceptor-common.ts`) and
 * `auth/nestor-model-snapshot.ts` (from `auth/nestor.ts`).
 *
 * Not a live break, which is why the residue stood as a comment for four days:
 * the PACKAGED runtime loads `apps/electron/dist/interceptor.cjs`, an esbuild
 * bundle that inlines every import, and the `.ts` copies serve the dev/monorepo
 * preload path where the missing modules resolve from the repo anyway. What the
 * derivation removes is the drift class — the list can no longer be short.
 *
 * Returns closure members WITHOUT the entry, as `/`-separated paths relative to
 * `INTERCEPTOR_SRC_DIR`, sorted. Throws rather than skipping when a member is
 * missing or escapes the staging root: a silently short closure is the defect
 * this function exists to make impossible.
 */
export function interceptorClosure(rootDir: string): string[] {
  const srcDir = join(rootDir, INTERCEPTOR_SRC_DIR);
  const queue: string[] = [INTERCEPTOR_ENTRY];
  const seen = new Set<string>(queue);
  const members: string[] = [];

  while (queue.length > 0) {
    const rel = queue.shift() as string;
    const abs = join(srcDir, ...rel.split('/'));
    if (!existsSync(abs)) {
      throw new Error(`Interceptor closure: ${rel} is imported but absent under ${INTERCEPTOR_SRC_DIR}.`);
    }
    for (const specifier of relativeImportsOf(readFileSync(abs, 'utf-8'))) {
      const member = resolveClosureMember(srcDir, rel, specifier);
      if (seen.has(member)) continue;
      seen.add(member);
      members.push(member);
      queue.push(member);
    }
  }

  return members.sort();
}

/**
 * Stage the interceptor and its derived closure under `destRoot`.
 *
 * @param rootDir repo root to read the sources from
 * @param destRoot tree to stage into; the sources keep their `INTERCEPTOR_SRC_DIR` layout
 * @returns every staged path, entry first, relative to `INTERCEPTOR_SRC_DIR`
 * @throws when the entry is missing or the closure cannot be resolved
 */
export function stageInterceptorSources(rootDir: string, destRoot: string): string[] {
  const sourceDir = join(rootDir, INTERCEPTOR_SRC_DIR);
  const entry = join(sourceDir, INTERCEPTOR_ENTRY);
  if (!existsSync(entry)) {
    throw new Error(`Interceptor not found at ${entry}`);
  }

  const staged = [INTERCEPTOR_ENTRY, ...interceptorClosure(rootDir)];
  for (const rel of staged) {
    const dest = join(destRoot, INTERCEPTOR_SRC_DIR, ...rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceDir, ...rel.split('/')), dest);
  }
  return staged;
}

/**
 * The loopback hosts the launcher exempts — see {@link launcherLoopbackNoProxyFragment}.
 */
export const LAUNCHER_LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1,[::1]';

/**
 * F1.518 — the shell lines `bin/nessy-server` runs before `exec bun`, so the
 * server's OWN loopback requests never reach a proxy it was launched with.
 *
 * Bun 1.3.14's `fetch` has no loopback exemption of its own, reads
 * `HTTP(S)_PROXY` and `NO_PROXY` once, at LAUNCH, and has no per-request way to
 * go direct (a `proxy: ""` option still proxies) — measured 2026-09-24 (WJ-ao,
 * following WJ-ai's P-WJai-2): with `HTTP_PROXY` at launch a request to
 * `http://127.0.0.1:<port>` arrived at the proxy in absolute form, and with
 * `NO_PROXY=…,127.0.0.1,…` at launch it went direct. So the launch environment is
 * the only place the server's whole process can be told, and these lines are
 * the native mechanism, set where it is read. That covers a codex or
 * claude-runtime hop to a loopback BYO endpoint (a local model), a local model
 * card's catalogue, and anything else the server itself sends to this machine;
 * the per-request resolver (`config/network-runtime.ts`) and the preloaded
 * interceptor both read the same launch `NO_PROXY` too.
 *
 * The same rule every subprocess env already follows
 * (`config/proxy-env.ts` `applyLoopbackProxyExemption`): written only when a
 * proxy name is set, so a server launched with none keeps a byte-identical
 * environment; EXTENDS the operator's value rather than replacing it (both
 * spellings unioned, lowercase first, then the loopback hosts); and writes BOTH
 * spellings, because a reader that prefers either one must see the loopback
 * entries. The hosts are {@link LAUNCHER_LOOPBACK_NO_PROXY}: a COPY of
 * `config/network-proxy-utils.ts` `LOOPBACK_NO_PROXY_HOSTS` (both IPv6 spellings,
 * for the reason that constant's docblock measures), kept a copy only because
 * this build module is typechecked as its own program and cited by line
 * elsewhere; `server-launcher-loopback-no-proxy.test.ts` fails the day the two
 * differ. `[::1]` in double quotes is not a glob.
 */
export function launcherLoopbackNoProxyFragment(): string {
  const loopback = LAUNCHER_LOOPBACK_NO_PROXY;
  // Blank first and last lines: it is interpolated on a line of its own, so it
  // reads as its own paragraph in the generated script.
  return [
    '',
    '# F1.518: the server\'s own loopback requests never go through a launch-environment',
    '# proxy (Bun has no loopback exemption and reads these names only at launch).',
    'if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}${ALL_PROXY:-}${all_proxy:-}" ]; then',
    '  NESSY_OPERATOR_NO_PROXY="${no_proxy:-}"',
    '  if [ -n "${NO_PROXY:-}" ] && [ "${NO_PROXY:-}" != "${no_proxy:-}" ]; then',
    '    NESSY_OPERATOR_NO_PROXY="${NESSY_OPERATOR_NO_PROXY:+$NESSY_OPERATOR_NO_PROXY,}$NO_PROXY"',
    '  fi',
    `  NO_PROXY="\${NESSY_OPERATOR_NO_PROXY:+$NESSY_OPERATOR_NO_PROXY,}${loopback}"`,
    '  no_proxy="$NO_PROXY"',
    '  export NO_PROXY no_proxy',
    '  unset NESSY_OPERATOR_NO_PROXY',
    'fi',
    '',
  ].join('\n');
}
