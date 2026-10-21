/**
 * P3.205 — the tripwire under `SdkAgentDefinition.isolation`.
 *
 * `claude-runtime-agents.ts` forwards `isolation` on a type the SDK's published
 * `.d.ts` does not declare (`SdkAgentDefinition = AgentDefinition & { isolation?:
 * AgentIsolation }`), and states IN PROSE why that is safe: the runtime's own
 * schema is a plain object schema, so it STRIPS an unknown key rather than
 * rejecting it, and "If a later SDK drops `isolation`, this becomes inert; it
 * cannot become the 'one entry fails, every agent vanishes' failure."
 *
 * That is the whole `ADVERTISED` failure shape: a key we send, a runtime that may
 * silently ignore it, and nothing on either side that would notice. Degrading to
 * NO isolation is not visible to the author who wrote `isolation: worktree`, to
 * the user, or to us. Prose cannot fail; this can.
 *
 * ## What is asserted, and on which artefact
 *
 * TWO channels carry `isolation`, and they are not the same claim — the file's
 * own note says the call-site one OUTRANKS the definition one (`j = s ?? U.isolation`).
 * Both are pinned, because a drop in either changes what our forwarded field can
 * still mean:
 *
 * 1. **The Agent tool's INPUT**, in the vendored `sdk-tools.d.ts`:
 *    `isolation?: "worktree" | "remote";` on `AgentInput`. A text file that ships
 *    on every platform, so this arm always runs.
 * 2. **The agent-DEFINITION schema**, in the platform's native binary: the zod
 *    entry the `agents` record is parsed through. It exists ONLY in the binary —
 *    measured 2026-09-02, `sdk.mjs` scores 0 for it (its own `bgIsolation:
 *    l.enum(["worktree","none"])` is a different field with different arms) — so
 *    reading the JS core instead would pin nothing.
 *
 * ## The minified receiver name is NOT pinned, deliberately
 *
 * `claude-runtime-agents.ts` records this schema as `b.enum([...])` inside an
 * object named `F3u`, measured on 0.3.218. On 0.3.223 it was `E.enum([...])` —
 * the identifier drifts with every minifier run and the object name is gone. So
 * the pattern below accepts ANY short identifier before the arms: the contract
 * is the FIELD and its two arms, never the letter upstream's minifier happened
 * to pick.
 *
 * ## …and `.enum` was a minified spelling too (S0-3, 0.3.223 → 0.3.233)
 *
 * The sentence above was right about the receiver and wrong about the CALL. At
 * 0.3.233 the same schema reads `isolation:Mr(["worktree","remote"]).optional()`
 * — the wrapper collapsed `<ident>.enum([...])` into a direct helper call — so a
 * pattern requiring the literal `.enum(` scored 0 and this tripwire reported an
 * upstream DROP of a field that is still there, twice, with both arms and
 * `.optional()`, plus a runtime validator (`let h=["worktree","remote"],
 * g=r.isolation`). A tripwire that cries wolf on a version bump is a tripwire
 * people delete, so `.enum` is now optional in the pattern: what is asserted is
 * `isolation:` + a call + the two arms + `.optional()`.
 *
 * ## A skipped tripwire is not a tripwire
 *
 * Both arms record what they actually read into `checked`, and the last case
 * asserts the list is non-empty and names the binary. An artefact that silently
 * failed to load would otherwise leave a green run that measured nothing — the
 * same "read the FILE COUNT, not the pass count" trap `AGENTS.md` records.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require_ = createRequire(import.meta.url);

/** The vendored SDK's own directory, resolved rather than guessed. */
function sdkDir(): string {
  return dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
}

/**
 * The platform binary package this install actually carries.
 *
 * `optionalDependencies` names eight, and linux has a `-musl` variant, so the
 * name is not simply `<platform>-<arch>`: the candidates are tried in order and
 * the first that exists on disk wins.
 */
function nativeBinaryPath(): string | undefined {
  const base = dirname(sdkDir());
  const arch = `${process.platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const suffix of [arch, `${arch}-musl`]) {
    const candidate = join(base, `claude-agent-sdk-${suffix}`, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Count regex matches over a file too large to hold as one string.
 *
 * `latin1` because the binary is not UTF-8 and the patterns are ASCII; the carry
 * is longer than any pattern here, so a match spanning a chunk boundary is still
 * seen. Measured 2026-09-02 at ~4s for the 272 MB darwin-arm64 binary under lane
 * load 9 — which is why the cases that use it carry an explicit timeout instead
 * of bun's 5s default.
 */
async function scanBinary(
  path: string,
  patterns: readonly RegExp[],
): Promise<Map<RegExp, number>> {
  const counts = new Map<RegExp, number>(patterns.map(pattern => [pattern, 0]));
  let carry = '';
  for await (const chunk of Bun.file(path).stream()) {
    const text = carry + Buffer.from(chunk as Uint8Array).toString('latin1');
    for (const pattern of patterns) {
      counts.set(pattern, (counts.get(pattern) ?? 0) + [...text.matchAll(pattern)].length);
    }
    carry = text.slice(-256);
  }
  return counts;
}

const checked: string[] = [];

describe('P3.205 — the vendored runtime still accepts `isolation` on an agent', () => {
  it('declares both arms on the Agent tool input, the channel that OUTRANKS the definition', () => {
    const path = join(sdkDir(), 'sdk-tools.d.ts');
    const source = readFileSync(path, 'utf-8');
    checked.push('sdk-tools.d.ts');

    // The forwarded field's sibling channel. A drop here would not make our
    // definition field inert, but it would remove the override the file's note
    // documents — so it is pinned in the same place.
    expect(source).toContain('isolation?: "worktree" | "remote";');

    // Positive control on the same rig: this file really is the Agent tool's
    // input declaration, so a zero above would be a real absence rather than a
    // mis-resolved path.
    expect(source).toContain('interface AgentInput');
    // Negative control: the reader is not matching everything it is asked for.
    expect(source).not.toContain('isolation?: "zzz-not-a-mode"');
  });

  it(
    'declares both arms on the agent-definition schema inside the native binary',
    async () => {
      const path = nativeBinaryPath();
      // Not a skip. Every platform the SDK supports ships one of these packages,
      // and a run that cannot find it has not verified anything — say so rather
      // than pass.
      expect(path).toBeDefined();

      // The receiver identifier is deliberately unpinned — see the header.
      const DEFINITION_SCHEMA = /isolation:[A-Za-z_$]{1,4}(?:\.enum)?\(\["worktree","remote"\]\)\.optional\(\)/g;
      const BOTH_ARMS = /(?:\.enum)?\(\["worktree","remote"\]\)/g;
      // Positive control on the same rig: a sentence measured in this binary by
      // a sibling row (P6.16). If the scan read nothing, this is 0 too.
      const POSITIVE = /Concurrent subagent limit reached/g;
      // Negative control: the scan is not answering yes to everything.
      const NEGATIVE = /zzz-not-in-this-binary-zzz/g;
      const counts = await scanBinary(path!, [DEFINITION_SCHEMA, BOTH_ARMS, POSITIVE, NEGATIVE]);
      const definitionSchema = counts.get(DEFINITION_SCHEMA) ?? 0;
      const toolSchema = counts.get(BOTH_ARMS) ?? 0;
      const positive = counts.get(POSITIVE) ?? 0;
      const negative = counts.get(NEGATIVE) ?? 0;

      checked.push(`native binary (${path!.split('/').slice(-2).join('/')})`);

      // THE ROW: the field our `SdkAgentDefinition` adds is still a field the
      // runtime parses, with BOTH arms. An upstream drop fails here loudly
      // instead of degrading a `isolation: worktree` agent to no isolation.
      expect(definitionSchema).toBeGreaterThan(0);
      // Both channels use the same two-arm enum, so the wider count can never be
      // below the definition one; a narrowing to one arm moves both.
      expect(toolSchema).toBeGreaterThanOrEqual(definitionSchema);
      expect(positive).toBeGreaterThan(0);
      expect(negative).toBe(0);
    },
    // Against the MEASURED floor (~4s at load 9), never zero.
    120_000,
  );

  it('actually read both artefacts, so a green run cannot mean an empty one', () => {
    expect(checked).toContain('sdk-tools.d.ts');
    expect(checked.some(entry => entry.startsWith('native binary'))).toBe(true);
  });
});
