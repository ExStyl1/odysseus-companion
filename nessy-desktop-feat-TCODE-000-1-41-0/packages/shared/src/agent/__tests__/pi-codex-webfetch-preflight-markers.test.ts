/**
 * P6.83 — the "no vendor preflight on Pi or codex" guarantee, pinned against
 * both vendored artefacts.
 *
 * ## Why one file and not two
 *
 * Ledger C2 asks a single question — *does a hostname I fetch leave the machine
 * for a vendor?* — and on claude the answer is a hardcoded
 * `https://api.anthropic.com/api/web/domain_info?domain=…`, pinned by P3.352 in
 * `claude-webfetch-preflight-markers.test.ts`. The Pi and codex cells said `n/a`
 * on nobody's measurement: the guarantee was believed, never instrumented. It is
 * ONE row because the two arms probe two vendored artefacts for the SAME absent
 * thing, and splitting them would let a Pi SDK bump and a codex binary bump each
 * be somebody else's problem.
 *
 * ## What is asserted, and the shape of each control
 *
 * Every absence below carries a POSITIVE CONTROL on the identical instrument, so
 * a probe that had stopped reading the artefact would fail rather than report a
 * clean bill of health — and a FABRICATED name at zero, so a probe that matched
 * everything could not make the absences pass for free.
 *
 * ## The premise correction this row produced
 *
 * The row's own note says the four codex names *"all → 0"*, and adds `domain_info`
 * → 0 for Pi. Measured at HEAD that is right for codex and right for `domain_info`
 * on Pi — but **`api.anthropic.com` is NOT absent from Pi's vendored tree.** Every
 * file carrying it is the Anthropic *model* provider's base URL —
 * `pi-ai/dist/providers/anthropic.*` and its bundled `@anthropic-ai/sdk` client
 * default, plus `pi-coding-agent`'s docs and a custom-provider example — a model
 * endpoint reached only when an operator configures an Anthropic connection, which
 * is a different proposition from a preflight that egresses a hostname you asked to
 * fetch. So the honest pin is not *"the string is absent"* (false, and it would go
 * red on the next SDK bump for no reason) but *"every file naming it is a provider
 * or a doc"* — which is the assertion that actually fails the day the string turns
 * up inside a tool.
 *
 * The file COUNT that stood here — twenty — is deliberately gone: it was a
 * reading with a date, it moved at the 0.84.3 lift, and the probes below already
 * carry their own non-vacuity controls. Ask the instrument, not this paragraph.
 *
 * ## The 0.84.3 lift, and why the file rule needed a second half
 *
 * That lift added `pi-coding-agent/dist/bundle/chunks/*`, where the SAME two
 * carriers (the model catalog's `baseUrl`, the bundled SDK client's `baseURL`
 * default) arrive inside a bundle of the whole application. "This file is the
 * provider" is not a proposition anyone can assert about a bundle — the provider
 * and every tool are the same file — so for those paths the rule drops one level
 * and reads each OCCURRENCE's own context instead. The question is unchanged:
 * a model endpoint, or something a hostname you asked to fetch could reach.
 *
 * ## The instrument, and why it is `find … -exec grep` and not `grep -r`
 *
 * Measured on this box, warm page cache, load ~10, the SAME absent needle over
 * `node_modules/@earendil-works` (10 319 files, 83 MB): `grep -a -q -r -F` took
 * **117 s**, `find … -type f -exec grep -a -l -F … {} +` took **2 s** — ~58x, and
 * reproduced on a second needle (109 s vs 3 s). A budget set for the fast form is
 * a flake for the slow one, so the form is part of the pin, not an implementation
 * detail. Timings quoted with their load per the standing rule; the tests below
 * carry an explicit budget set against the measured floor rather than bun's 5 s
 * default.
 *
 * Presence is asked with `grep -a -q`, never a count: over a binary a
 * `grep -a -c` counts LINES, which is why an in-tree comment records `CODEX_HOME`
 * as 34 by occurrence against 28 by line.
 *
 * ## The caveat that survives this row
 *
 * DNS still reaches the configured resolver on all three runtimes — Pi's own
 * `validateUrl` resolves every hostname through `dns.lookup()` before fetching, by
 * design (SSRF defence). C2's clause is about `api.anthropic.com`, not about
 * whether a name is resolved at all.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

const PI_VENDOR_DIR = (() => {
  const entry = Bun.resolveSync('@earendil-works/pi-ai', import.meta.dir);
  return entry.slice(0, entry.lastIndexOf('/@earendil-works/')) + '/@earendil-works';
})();

/**
 * Files under `dir` containing `needle`, read as bytes. `find -type f` rather
 * than `grep -r` for the 58x reason in the docblock; `-type f` also means no
 * symlink is ever followed, so a `.bin/` link cannot be counted twice.
 */
const filesNaming = (dir: string, needle: string): string[] => {
  const found = Bun.spawnSync([
    'find', dir, '-type', 'f', '-exec', 'grep', '-a', '-l', '-F', '-e', needle, '{}', '+',
  ]);
  return new TextDecoder().decode(found.stdout).split('\n').filter(line => line.length > 0);
};

/** One `grep -a -q -F` pass over one artefact; `-q` stops at the first hit. */
const inArtefact = (path: string, needle: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', needle, path]).exitCode === 0;

/**
 * `text` with its comments removed, so a sentence mentioning a call cannot be
 * counted as one. Block comments first, then whole-line `//` comments — enough
 * for the one count below, and deliberately not a parser.
 */
/**
 * The vendored chunks of `pi-coding-agent`'s own bundle. They arrived with the
 * 0.84.3 lift and are the reason the vendor-host rule has two halves: a bundle
 * has no single provenance, so its carriers are judged per occurrence.
 */
const BUNDLE_CHUNK = /^pi-coding-agent\/dist\/bundle\//;

const codeOf = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const findStagedCodexAppServer = (): string | undefined => {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const exe = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  const candidate = repoFile(
    `apps/electron/resources/bin/codex/${process.platform}-${arch}/${exe}`,
  );
  return existsSync(candidate) ? candidate : undefined;
};

describe('P6.83 · Pi — the one outbound call the web_fetch tool makes', () => {
  const source = readFileSync(repoFile('packages/pi-agent-server/src/tools/web-fetch.ts'), 'utf8');

  it('names no vendor host and reaches only the URL it was asked for, or a same-host hop of it', () => {
    // POSITIVE CONTROL on the read itself: this is the web_fetch tool and not
    // some other file that happens to have no vendor host in it.
    expect(source).toContain("name: 'web_fetch'");
    expect(source).toContain("import { lookup } from 'node:dns/promises';");

    // (1) Exactly ONE `fetch(` call expression in the whole tool, and its
    // argument is the target it was handed.
    //
    // `a0e5038b3` (2026-09-06) replaced `response = await fetch(url, …)` with a
    // hand-walked redirect chain — `tools-reference.md#webfetch-tool-behavior`
    // specifies following redirects, and `redirect: 'manual'` is the only way to
    // SEE a hop and refuse a cross-host one — so the tool now reaches the
    // caller's URL and, at most, same-host redirect targets of it. That is more
    // than one URL and it is still no vendor's: the shape asserted here is the
    // injected `fetchImpl`, which is the single place a request leaves this file.
    // Counted over CODE, not prose: the SSRF docblock in that file says
    // "the subsequent fetch()", and a count taken over the raw text would be one
    // comment edit away from a stale number.
    expect(codeOf(source).match(/\bfetch\(/g)).toHaveLength(1);
    expect(source).toContain('{ fetchImpl: (target, init) => fetch(target, init), validate: validateUrl }');
    // A CROSS-host hop is refused rather than followed, which is what keeps
    // "only the URL it was asked for" true of the hosts reached.
    expect(source).toContain("return { kind: 'cross-host', from: startUrl, to: target };");

    // (2) No vendor host, under any of the three spellings a preflight could use.
    for (const host of ['api.anthropic.com', 'domain_info', 'anthropic.com']) {
      expect(source, `${host} appears in the Pi web_fetch tool`).not.toContain(host);
    }
  });

  it('validates locally, and does so BEFORE the fetch rather than by asking anyone', () => {
    const validate = source.indexOf('await validateUrl(url);');
    const fetched = source.indexOf('outcome = await resolveRedirects(');
    expect(validate).toBeGreaterThan(-1);
    expect(fetched).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(fetched);
    // And AGAIN on every hop, because DNS can answer differently for the same
    // name between hops — the half a single before-the-fetch check would miss
    // now that the chain is walked by hand.
    expect(source).toContain('await deps.validate(target);');
    // The validator's own reach: a DNS resolution and a private-IP refusal, both
    // in this file. If validation ever grows a network call, the count above
    // moves and the first test fails.
    expect(source).toContain('await lookup(hostname');
  });
});

describe('P6.83 · Pi — the vendored SDK carries no preflight endpoint', () => {
  // ~2-3 s per needle at load ~10 (measured); the budget is that floor with
  // headroom for a loaded wave, not bun's 5 s default.
  it('scores the preflight name at zero, with both controls on the same instrument', () => {
    // THE ABSENCE: the discriminator of claude's preflight, nowhere in Pi's tree.
    expect(filesNaming(PI_VENDOR_DIR, 'domain_info')).toEqual([]);

    // POSITIVE CONTROL: the instrument reads this tree at all.
    expect(filesNaming(PI_VENDOR_DIR, 'telemetry').length).toBeGreaterThan(0);

    // ZERO CONTROL: a name that cannot be there. Without it a `find` that
    // silently returned nothing would make the absence above pass for free.
    expect(filesNaming(PI_VENDOR_DIR, 'zzNotAVendorHostP683')).toEqual([]);
  }, 120_000);

  /**
   * The premise correction, pinned rather than written in prose: the vendor host
   * IS in this tree, and every file carrying it is a model provider or a
   * document. A bump that puts it inside a TOOL fails here.
   */
  it('confines the vendor host to the Anthropic model provider and its docs', () => {
    const carriers = filesNaming(PI_VENDOR_DIR, 'api.anthropic.com')
      .map(path => path.slice(path.lastIndexOf('/@earendil-works/') + '/@earendil-works/'.length));

    // POSITIVE CONTROL: the list is not vacuously empty.
    expect(carriers.length).toBeGreaterThan(0);

    const provenance = /^(pi-agent-core\/node_modules\/@earendil-works\/)?(pi-ai\/(dist\/providers\/|node_modules\/@anthropic-ai\/sdk\/)|pi-coding-agent\/(docs\/|examples\/))/;
    for (const carrier of carriers) {
      if (BUNDLE_CHUNK.test(carrier)) continue; // asserted per OCCURRENCE below
      expect(carrier, `${carrier} names api.anthropic.com and is not a provider or a doc`)
        .toMatch(provenance);
    }
  }, 120_000);

  /**
   * The 0.84.3 lift put the same two carriers in a THIRD shape, and a file-level
   * rule cannot read it.
   *
   * `pi-coding-agent/dist/bundle/chunks/*` is a BUNDLE: the whole app is in it,
   * so "this file is the Anthropic provider" stops being a proposition anyone
   * can assert about it — the provider and every tool are the same file. The
   * question the row actually asks survives one level down: *is each occurrence
   * a model endpoint, or something a fetched hostname could reach?* Both spellings
   * a provider uses are `baseUrl`/`baseURL`; a preflight would not be.
   */
  it('confines it INSIDE the bundled chunks too, occurrence by occurrence', () => {
    const chunks = filesNaming(PI_VENDOR_DIR, 'api.anthropic.com')
      .filter(path => BUNDLE_CHUNK.test(
        path.slice(path.lastIndexOf('/@earendil-works/') + '/@earendil-works/'.length)));

    // POSITIVE CONTROL: the bundle really does carry the host, so the per-hit
    // rule below is a bound and not an empty loop. (Two chunks at the 0.84.3
    // lift; the count is not pinned, the shape of each hit is.)
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      const text = readFileSync(chunk, 'latin1');
      let hits = 0;
      for (const match of text.matchAll(/api\.anthropic\.com/g)) {
        hits += 1;
        const before = text.slice(Math.max(0, match.index - 60), match.index);
        expect(before, `${chunk} names api.anthropic.com outside a provider base URL: …${before}`)
          .toMatch(/baseURL?\b/i);
      }
      expect(hits, `${chunk} stopped carrying the host`).toBeGreaterThan(0);
    }
  }, 120_000);
});

const stagedCodexBinary = findStagedCodexAppServer();

describe('P6.83 · codex — the shipped app-server has no URL-fetch tool at all', () => {
  /**
   * Skipped VISIBLY — as a skip line, not a silent pass — when no
   * `codex-app-server` is staged for this platform: the binaries are gitignored,
   * so a clean checkout has none.
   */
  it.skipIf(stagedCodexBinary === undefined)(
    'scores four fetch names at zero against three controls that are present',
    () => {
      const binary = stagedCodexBinary!;

      // THE ABSENCES: the preflight endpoint, the vendor host, and the two names
      // a URL-fetch tool would be registered under.
      for (const absent of ['api/web/domain_info', 'api.anthropic.com', 'web_fetch', 'fetch_url']) {
        expect(inArtefact(binary, absent), `${absent} is present in ${binary}`).toBe(false);
      }

      // POSITIVE CONTROLS: three strings this binary demonstrably carries. If the
      // probe stopped reading, these fail before any absence is believed.
      // `web_search` is the sharpest of the three — codex HAS a web capability,
      // it simply is not a URL fetch, so "no network tool" would be the wrong
      // conclusion to draw from the absences above.
      for (const present of ['CODEX_HOME', 'apply_patch', 'web_search']) {
        expect(inArtefact(binary, present), `${present} is missing from ${binary}`).toBe(true);
      }

      // ZERO CONTROL on the identical instrument.
      expect(inArtefact(binary, 'zzNotACodexSymbolP683')).toBe(false);
    },
    120_000,
  );
});
