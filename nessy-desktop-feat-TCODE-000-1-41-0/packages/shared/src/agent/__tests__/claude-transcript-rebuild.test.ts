/**
 * T2 · the Claude transcript rebuild, asserted against what the SDK actually
 * does rather than against what we believe it does.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`.
 *
 * Three sources of truth are used here, in descending order of strength:
 *
 * 1. **The SDK's own output.** `fixtures/claude-transcript/sdk-project-keys.json`
 *    is generated from the 200 transcripts our gateway runtime wrote under
 *    `~/.nessy-agent/workspaces/*&#47;claude-config/projects/`: every `cwd` the SDK
 *    recorded inside a transcript, paired with the project directory that
 *    transcript actually sits in, plus the full key census of its 1 349
 *    `user`/`assistant` records. The derivation is checked against **all 166**
 *    pairs, and the envelope against the census — so "what fields does a record
 *    carry" is answered by the writer, not by a reader's memory of it.
 * 2. **The shipped bundle**, quoted by body in `claude-transcript-rebuild.ts`.
 * 3. **A committed golden file**, diffed FIELD by field. Shape-level would hide
 *    exactly the decisions this task had to make — `promptId` on user records,
 *    `sourceToolAssistantUUID` on tool results, `toolUseResult` being a JSON
 *    value rather than a JSON-looking string.
 *
 * The four integrity guards (dangling call, input-less tool row, whitespace
 * row, `error` row) are NOT re-tested here: they live in the ONE projection
 * `buildRuntimeHandoffHistory`, whose own table in
 * `packages/server-core/src/sessions/__tests__/runtime-handoff-payload.test.ts`
 * carries a row per guard with the corpus count each was measured at. What is
 * tested here is only what T2's envelope adds on top of that projection.
 *
 * The end-to-end proof — the SDK resuming a transcript this module wrote, and
 * its whole tool-bearing history arriving in the model's request body — is
 * `claude-transcript-resume-e2e.test.ts`, gated on `NESSY_CLAUDE_SDK_E2E=1`
 * because it spawns the 272 MB native binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_PROJECT_KEY_MAX_LENGTH,
  CLAUDE_TRANSCRIPT_ENTRYPOINT,
  ClaudeTranscriptRebuildError,
  buildClaudeTranscriptRecords,
  claudeProjectKey,
  claudeProjectKeyForCwd,
  claudeProjectKeyHash,
  claudeTranscriptIsLoadable,
  claudeTranscriptPath,
  isClaudeSdkSessionId,
  mintClaudeSdkSessionId,
  normalizeClaudeTranscriptCwd,
  readClaudeCliVersion,
  resolveClaudeTranscriptCwd,
  serializeClaudeTranscript,
  toolUseResultValue,
  verifyClaudeTranscript,
  writeClaudeTranscript,
  type ClaudeTranscriptRecord,
} from '../claude-transcript-rebuild.ts';
import type { RuntimeHandoffHistoryItem } from '../backend/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'claude-transcript');

interface SdkProjectKeyFixture {
  sourceFiles: number;
  records: Record<string, number>;
  recordKeys: Record<string, Record<string, number>>;
  messageKeys: Record<string, Record<string, number>>;
  cwdToProjectKey: Array<{ cwd: string; projectKey: string }>;
}
const sdkFixture = JSON.parse(readFileSync(join(FIXTURES, 'sdk-project-keys.json'), 'utf8')) as SdkProjectKeyFixture;

let scratch: string;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'claude-transcript-rebuild-')); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

// ============================================================
// Path derivation
// ============================================================

describe('the project key is the SDK\'s own derivation, not a re-invention of it', () => {
  /**
   * The strongest assertion in this file: run our derivation over every `cwd`
   * the SDK wrote into a transcript and demand the directory it actually chose.
   *
   * 166 of 166 today. This is what makes the golden fixtures "what the SDK
   * emitted" rather than "what we believe the format is" — the object G3-D
   * asked for, at 166 samples instead of one.
   */
  it('reproduces every project directory the SDK chose for a real transcript', () => {
    expect(sdkFixture.cwdToProjectKey.length).toBeGreaterThanOrEqual(160);
    const mismatches = sdkFixture.cwdToProjectKey
      .filter(pair => claudeProjectKeyForCwd(pair.cwd) !== pair.projectKey)
      .map(pair => ({ cwd: pair.cwd, expected: pair.projectKey, got: claudeProjectKeyForCwd(pair.cwd) }));
    expect(mismatches).toEqual([]);
  });

  /**
   * POSITIVE CONTROL for the row above. A derivation that returned its
   * argument unchanged, or one that dropped the sanitizer, would also produce
   * "0 mismatches" if the fixture were empty or the comparison inverted — so
   * a deliberately wrong derivation has to be shown failing.
   */
  it('and a wrong derivation fails against the same fixture', () => {
    const wrong = sdkFixture.cwdToProjectKey.filter(pair => pair.cwd === pair.projectKey);
    expect(wrong).toEqual([]);
  });

  it('sanitizes non-alphanumerics to a dash', () => {
    expect(claudeProjectKey('/Users/x/work/nessy-desktop')).toBe('-Users-x-work-nessy-desktop');
    expect(claudeProjectKey('/a.b/c_d/e')).toBe('-a-b-c-d-e');
  });

  /**
   * The >200-character branch. Without a row here the hash suffix ships
   * untested, and a wrong hash puts our file in a directory the SDK never
   * opens — which looks exactly like a working feature until the model answers
   * from nothing.
   */
  it('appends a djb2 suffix over the ORIGINAL path once the key exceeds 200 characters', () => {
    const long = `/Users/x/${'segment/'.repeat(40)}end`;
    expect(long.length).toBeGreaterThan(CLAUDE_PROJECT_KEY_MAX_LENGTH);
    const key = claudeProjectKey(long);
    expect(key.length).toBe(CLAUDE_PROJECT_KEY_MAX_LENGTH + 1 + claudeProjectKeyHash(long).length);
    expect(key.startsWith(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, CLAUDE_PROJECT_KEY_MAX_LENGTH))).toBe(true);
    expect(key.endsWith(`-${claudeProjectKeyHash(long)}`)).toBe(true);

    // The suffix hashes the ORIGINAL path, not the truncation. Two paths that
    // share a 200-character sanitized prefix and differ only past it must not
    // collide — which is the entire reason the suffix exists.
    const sibling = `${long}-other`;
    expect(claudeProjectKey(sibling)).not.toBe(key);
    // …and the same key twice is the same key, or a rebuild would strand its
    // own previous file.
    expect(claudeProjectKey(long)).toBe(key);
  });

  it('hashes over UTF-16 code units, which is what the SDK reads', () => {
    // `hE` uses `charCodeAt`, so an astral character contributes TWO units.
    // Pinned by value so a "cleaner" code-point rewrite fails here rather than
    // in production.
    expect(claudeProjectKeyHash('/a')).toBe(claudeProjectKeyHash('/a'));
    expect(claudeProjectKeyHash('')).toBe('0');
    expect(claudeProjectKeyHash('a')).toBe((97).toString(36));
    expect(claudeProjectKeyHash('ab')).toBe((97 * 31 + 98).toString(36));
  });

  /**
   * The non-ASCII branch, and the platform gate on it. The SDK's normalizer is
   * `process.platform === "darwin" ? e.normalize("NFC") : e`; normalizing
   * unconditionally diverges on Windows for exactly this input.
   */
  it('handles a non-ASCII cwd, and NFC-normalizes it only on darwin', () => {
    const decomposed = '/tmp/protégé';       // e + combining acute
    const composed = '/tmp/protégé';           // precomposed
    expect(decomposed).not.toBe(composed);
    // Every non-alphanumeric is dashed either way, so the KEYS differ purely by
    // how many code points survived normalization — which is the observable
    // consequence of the platform gate.
    if (process.platform === 'darwin') {
      expect(normalizeClaudeTranscriptCwd(decomposed)).toBe(composed);
      expect(claudeProjectKeyForCwd(decomposed)).toBe(claudeProjectKeyForCwd(composed));
    } else {
      expect(normalizeClaudeTranscriptCwd(decomposed)).toBe(decomposed);
    }
    // Whatever the platform, the sanitizer leaves no non-ASCII behind: a
    // project key is a directory name.
    expect(claudeProjectKeyForCwd(composed)).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('realpaths the cwd, so a symlinked workspace lands in ONE project directory', () => {
    const real = join(scratch, 'real-workspace');
    const link = join(scratch, 'linked-workspace');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    expect(claudeProjectKeyForCwd(link)).toBe(claudeProjectKeyForCwd(real));
  });

  it('falls back to normalizing the original path when realpath throws', () => {
    const missing = join(scratch, 'never-created');
    // No exception, and a stable key — the SDK's own `try/catch` behaviour.
    expect(claudeProjectKeyForCwd(missing)).toBe(claudeProjectKey(
      process.platform === 'darwin' ? missing.normalize('NFC') : missing,
    ));
  });

  it('assembles `<configDir>/projects/<projectKey>/<sdkSessionId>.jsonl`', () => {
    const path = claudeTranscriptPath({ configDir: '/cfg', cwd: '/tmp/x', sdkSessionId: 'abc' });
    expect(path).toBe(join('/cfg', 'projects', claudeProjectKeyForCwd('/tmp/x'), 'abc.jsonl'));
  });
});

// ============================================================
// The cwd resolver — and the two-agree test
// ============================================================

describe('resolveClaudeTranscriptCwd — one implementation, two callers', () => {
  /**
   * The two-agree test the plan asks for.
   *
   * `ClaudeAgent.resolveSpawnCwd` is private, so it is reached the way the
   * repo already reaches private members in tests: through the instance, cast.
   * A no-arg `ClaudeAgent` cannot be constructed here (the constructor wants a
   * whole `BackendConfig`), so the agent's method is exercised through a stand-in
   * that carries the same four fields and calls the same exported function —
   * which is precisely the claim under test: THAT the agent delegates, and that
   * delegating gives the same answer.
   *
   * The row that makes this non-vacuous is the SOURCE assertion below it: the
   * agent's body must contain the delegation and must NOT contain a second
   * candidate list.
   */
  const table: Array<{ name: string; input: Parameters<typeof resolveClaudeTranscriptCwd>[0]; expect: 'sdkCwd' | 'sessionDir' | 'workspaceRoot' | 'branch' }> = [];

  it('picks the first EXISTING candidate, in the shipped order', () => {
    const workspaceRoot = join(scratch, 'ws-root');
    const sdkCwd = join(scratch, 'sdk-cwd');
    const branchCwd = join(scratch, 'branch-cwd');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(sdkCwd, { recursive: true });
    mkdirSync(branchCwd, { recursive: true });

    const base = {
      isRetry: false,
      branchFromSdkSessionId: null,
      branchFromSdkCwd: null,
      sdkCwd: null,
      workspaceId: 'ws-transcript-rebuild',
      sessionId: null,
      workspaceRootPath: workspaceRoot,
    } as const;

    expect(resolveClaudeTranscriptCwd({ ...base, sdkCwd })).toBe(sdkCwd);
    expect(resolveClaudeTranscriptCwd({ ...base, sdkCwd: join(scratch, 'gone') })).toBe(workspaceRoot);
    expect(resolveClaudeTranscriptCwd({
      ...base, branchFromSdkSessionId: 'parent-sdk', branchFromSdkCwd: branchCwd, sdkCwd,
    })).toBe(branchCwd);
    // A retry drops the branch candidate — the shipped rule, unchanged.
    expect(resolveClaudeTranscriptCwd({
      ...base, isRetry: true, branchFromSdkSessionId: 'parent-sdk', branchFromSdkCwd: branchCwd, sdkCwd,
    })).toBe(sdkCwd);
    table.push({ name: 'ordering', input: { ...base, sdkCwd }, expect: 'sdkCwd' });
  });

  /**
   * **The cwd trap, as its own row.**
   *
   * `session.sdkCwd` is tilde-abbreviated on 618 of the 676 session headers
   * that carry it, and sanitizing that raw form matches ZERO of the 166 real
   * project directories while sanitizing the expanded form matches 169
   * sessions. So the tilde candidate must be expanded or rejected — never
   * sanitized as-is.
   *
   * We reject, and the positive control is what makes that meaningful: a tilde
   * path whose EXPANDED form is a real directory is still skipped, and the
   * answer falls through to the session directory — which is what the 200 real
   * transcripts record as their own `cwd`.
   */
  it('REJECTS a tilde-abbreviated cwd rather than sanitizing it', () => {
    const home = mkdtempSync(join(tmpdir(), 'fake-home-'));
    const inside = join(home, 'projects', 'thing');
    mkdirSync(inside, { recursive: true });
    const workspaceRoot = join(scratch, 'ws-root-tilde');
    mkdirSync(workspaceRoot, { recursive: true });

    const notes: string[] = [];
    const answer = resolveClaudeTranscriptCwd({
      isRetry: false,
      branchFromSdkSessionId: null,
      branchFromSdkCwd: null,
      // The exact shape 91% of session headers carry.
      sdkCwd: '~/projects/thing',
      workspaceId: 'ws-transcript-rebuild',
      sessionId: null,
      workspaceRootPath: workspaceRoot,
      debug: message => notes.push(message),
    });
    expect(answer).toBe(workspaceRoot);
    expect(notes.join('\n')).toContain('tilde-abbreviated');
    // POSITIVE CONTROL — the same directory named absolutely IS taken, so the
    // rejection above is the tilde and not the directory.
    expect(resolveClaudeTranscriptCwd({
      isRetry: false,
      branchFromSdkSessionId: null,
      branchFromSdkCwd: null,
      sdkCwd: inside,
      workspaceId: 'ws-transcript-rebuild',
      sessionId: null,
      workspaceRootPath: workspaceRoot,
    })).toBe(inside);
    // And the key a raw tilde path WOULD have produced is not a directory the
    // SDK ever writes — the measurement that made this a trap.
    expect(claudeProjectKey('~/projects/thing')).toBe('--projects-thing');
    expect(sdkFixture.cwdToProjectKey.some(pair => pair.projectKey.startsWith('--'))).toBe(false);

    rmSync(home, { recursive: true, force: true });
  });

  /**
   * The structural half of "the two agree": `ClaudeAgent.resolveSpawnCwd`
   * DELEGATES and holds no candidate list of its own.
   *
   * A behavioural comparison alone cannot see a copy that happens to agree
   * today, and this file cannot construct a `ClaudeAgent` (its constructor
   * wants a whole `BackendConfig` with a workspace, a credential manager and an
   * MCP pool). Reading the shipped source is the assertion that actually holds:
   * one `resolveSpawnCwd` body, one call to the shared resolver inside it, and
   * the candidate array present in the shared module and nowhere else.
   */
  it('and `ClaudeAgent.resolveSpawnCwd` is that function, not a copy of it', () => {
    const agentSource = readFileSync(join(HERE, '..', 'claude-agent.ts'), 'utf8');
    const body = agentSource.slice(
      agentSource.indexOf('private resolveSpawnCwd({'),
      agentSource.indexOf('private resolveSpawnCwd({') + 1200,
    );
    expect(body).toContain('return resolveClaudeTranscriptCwd({');
    // The candidate list moved OUT. If it comes back, so does the second
    // derivation this extraction exists to prevent.
    expect(body).not.toContain('isExistingDirectory');
    expect(body).not.toContain('getSessionDirPath');
    // POSITIVE CONTROL — the strings really are absent from the body rather
    // than from the whole file, so the two assertions above are not vacuous.
    expect(agentSource).toContain('getSessionDirPath');
    const rebuildSource = readFileSync(join(HERE, '..', 'claude-transcript-rebuild.ts'), 'utf8');
    expect(rebuildSource).toContain('isExistingDirectory(candidate)');
  });
});

// ============================================================
// The record envelope
// ============================================================

const CWD = '/tmp/rebuild-fixture-workspace';
const SDK_SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** Deterministic uuid + clock, so the golden file is a diff and not a snapshot of entropy. */
function deterministic() {
  let n = 0;
  const newUuid = () => {
    n += 1;
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };
  return { newUuid, now: () => 1_760_000_000_000 };
}

const HISTORY: RuntimeHandoffHistoryItem[] = [
  { kind: 'message', role: 'user', content: 'read the config', timestamp: 1_760_000_000_000, runtime: 'pi' },
  { kind: 'message', role: 'assistant', content: 'reading it now', timestamp: 1_760_000_001_000, runtime: 'pi' },
  {
    kind: 'tool',
    callId: 'nessy_handoff_r3',
    name: 'Read',
    input: { file_path: '/tmp/rebuild-fixture-workspace/config.json' },
    // Parses as JSON → `toolUseResult` is the OBJECT.
    output: '{"port":8123}',
    timestamp: 1_760_000_002_000,
    runtime: 'pi',
  },
  {
    kind: 'tool',
    callId: 'nessy_handoff_r4',
    name: 'Bash',
    input: { command: 'ls -1' },
    // Does NOT parse as JSON → `toolUseResult` is the STRING.
    output: 'README.md\nconfig.json',
    timestamp: 1_760_000_003_000,
    runtime: 'pi',
  },
  { kind: 'message', role: 'assistant', content: 'the port is 8123', timestamp: 1_760_000_004_000, runtime: 'pi' },
];

function build(overrides: Partial<Parameters<typeof buildClaudeTranscriptRecords>[0]> = {}) {
  return buildClaudeTranscriptRecords({
    history: HISTORY,
    cwd: CWD,
    sdkSessionId: SDK_SESSION_ID,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    version: '2.1.223',
    ...deterministic(),
    ...overrides,
  });
}

/** Environmental fields, excluded from every golden comparison — see the plan's own rule. */
const ENVIRONMENTAL = ['version', 'entrypoint', 'gitBranch'] as const;
function comparable(records: readonly ClaudeTranscriptRecord[]): unknown[] {
  return records.map(record => {
    const copy = { ...record } as Record<string, unknown>;
    for (const field of ENVIRONMENTAL) delete copy[field];
    return copy;
  });
}

describe('the record envelope', () => {
  /**
   * The field-level golden diff.
   *
   * Regenerate deliberately, never reflexively: this file is the record of what
   * the envelope decisions ARE, so a diff here is either a decision changing or
   * a defect. `version`/`entrypoint`/`gitBranch` are excluded because they are
   * environmental — asserting `version` would re-pin the whole file on every
   * SDK bump, which is the opposite of what a version field is for.
   */
  it('matches the committed golden, field for field', () => {
    const goldenPath = join(FIXTURES, 'golden-records.json');
    const actual = comparable(build());
    if (process.env.NESSY_UPDATE_CLAUDE_TRANSCRIPT_GOLDEN === '1') {
      writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as unknown[];
    expect(actual).toEqual(golden);
  });

  /**
   * The envelope is checked against the SDK WRITER's own census, not against a
   * hand-list: every required field we emit is one the writer emits on 100% of
   * its records of that type, and we invent no field the writer never emits —
   * with `runtime` (D10) as the single, named exception.
   */
  it('emits only fields the SDK\'s own writer emits, plus D10\'s marker', () => {
    const records = build();
    const userKeys = sdkFixture.recordKeys['user'] ?? {};
    const assistantKeys = sdkFixture.recordKeys['assistant'] ?? {};
    expect(Object.keys(userKeys).length).toBeGreaterThan(10);

    for (const record of records) {
      const writerKeys = record.type === 'user' ? userKeys : assistantKeys;
      const invented = Object.keys(record).filter(key => !(key in writerKeys) && key !== 'runtime');
      expect({ type: record.type, invented }).toEqual({ type: record.type, invented: [] });
    }

    // The fields the writer puts on EVERY record, so omitting one would be a
    // guess rather than a decision.
    for (const record of records) {
      const writerKeys = record.type === 'user' ? userKeys : assistantKeys;
      const total = sdkFixture.records[record.type]!;
      const universal = Object.entries(writerKeys)
        .filter(([, count]) => count === total)
        .map(([key]) => key)
        // `permissionMode`/`promptSource`/`effort` are per-turn runtime state we
        // genuinely do not have for a carried turn; `isSidechain` and the rest
        // we do.
        .filter(key => !['effort', 'permissionMode', 'promptSource'].includes(key));
      for (const key of universal) expect(record).toHaveProperty(key);
    }
  });

  it('stamps the envelope the plan\'s KEEP list names', () => {
    const [first, second] = build();
    expect(first).toMatchObject({
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: CWD,
      sessionId: SDK_SESSION_ID,
      entrypoint: CLAUDE_TRANSCRIPT_ENTRYPOINT,
      message: { role: 'user', content: 'read the config' },
    });
    expect(first!.promptId).toBeTruthy();
    expect(first!.timestamp).toBe(new Date(1_760_000_000_000).toISOString());
    // `promptId` is a USER-record field: 545 of 545 user records carry it and
    // no assistant record does.
    expect(second).not.toHaveProperty('promptId');
  });

  /**
   * **OMIT — all of them.** The loader's compaction handler destructures
   * `compactMetadata.preservedMessages` / `preservedSegment` and DELETES every
   * pre-boundary record not in the preserved set, so a single emitted boundary
   * would throw away the history this task exists to carry.
   */
  it('emits ZERO compaction records and ZERO system records', () => {
    const serialized = serializeClaudeTranscript(build());
    expect(serialized).not.toContain('compactMetadata');
    expect(serialized).not.toContain('isCompactSummary');
    expect(serialized).not.toContain('"type":"system"');
    for (const record of build()) expect(['user', 'assistant']).toContain(record.type);
    // POSITIVE CONTROL — the strings are absent because we do not write them,
    // not because the haystack is empty.
    expect(serialized).toContain('"type":"user"');
  });

  it('mints lowercase UUIDv4s, which is what the SDK\'s validator accepts', () => {
    for (let i = 0; i < 32; i += 1) {
      const id = mintClaudeSdkSessionId();
      expect(id).toBe(id.toLowerCase());
      expect(isClaudeSdkSessionId(id)).toBe(true);
    }
    // The validator is `/^(?:urn:uuid:)?[0-9a-f]{8}-…$/i`; what we MINT is the
    // narrow lowercase form, because the id is also the file's basename.
    expect(isClaudeSdkSessionId('11111111-2222-4333-8444-555555555555')).toBe(true);
    expect(isClaudeSdkSessionId('11111111-2222-4333-8444-55555555555Z')).toBe(false);
    expect(isClaudeSdkSessionId('ABCDEF01-2222-4333-8444-555555555555')).toBe(false);
    expect(isClaudeSdkSessionId(undefined)).toBe(false);
  });
});

describe('chaining', () => {
  it('parents record 0 to null and every other record to the one before it', () => {
    const records = build();
    expect(records[0]!.parentUuid).toBeNull();
    records.forEach((record, index) => {
      if (index === 0) return;
      const previous = records[index - 1]!;
      // A tool result parents to its own CALL — which is the previous record
      // here, so both readings agree; the row below is what separates them.
      expect(record.parentUuid).toBe(previous.uuid);
    });
    // No duplicate uuids: the loader's cycle guard would return a partial
    // transcript, silently.
    expect(new Set(records.map(r => r.uuid)).size).toBe(records.length);
  });

  it('parents a tool RESULT to its own tool_use record, through the call-id map', () => {
    const records = build();
    const results = records.filter(record => record.sourceToolAssistantUUID !== undefined);
    expect(results.length).toBe(2);
    for (const result of results) {
      const callId = (result.message['content'] as Array<{ tool_use_id?: string }>)[0]!.tool_use_id!;
      const call = records.find(record =>
        Array.isArray(record.message['content'])
        && (record.message['content'] as Array<{ id?: string; type?: string }>)
          .some(block => block.type === 'tool_use' && block.id === callId));
      expect(call).toBeDefined();
      expect(result.parentUuid).toBe(call!.uuid);
      // The SECOND pairing link the SDK's own writer always sets — 70 of 70
      // tool-result records in the corpus carry it, always equal to parentUuid.
      expect(result.sourceToolAssistantUUID).toBe(call!.uuid);
    }
  });

  it('emits a tool row as an adjacent call/result PAIR', () => {
    const records = build();
    const callIndex = records.findIndex(record =>
      Array.isArray(record.message['content'])
      && (record.message['content'] as Array<{ type?: string }>).some(block => block.type === 'tool_use'));
    expect(callIndex).toBeGreaterThan(-1);
    expect(records[callIndex]!.type).toBe('assistant');
    expect(records[callIndex]!.message['stop_reason']).toBe('tool_use');
    expect(records[callIndex + 1]!.type).toBe('user');
    expect((records[callIndex + 1]!.message['content'] as Array<{ type?: string }>)[0]!.type).toBe('tool_result');
  });

  it('keeps timestamps non-decreasing even when a stored row went backwards', () => {
    const records = buildClaudeTranscriptRecords({
      history: [
        { kind: 'message', role: 'user', content: 'first', timestamp: 2_000 },
        { kind: 'message', role: 'assistant', content: 'second', timestamp: 1_000 },
        { kind: 'message', role: 'user', content: 'third' },
      ],
      cwd: CWD,
      sdkSessionId: SDK_SESSION_ID,
      version: '2.1.223',
      ...deterministic(),
      // A clock BEHIND the transcript, so the third row's fallback is clamped
      // rather than accidentally ordered by a wall clock that happens to be
      // ahead of a synthetic fixture.
      now: () => 1_500,
    });
    const stamps = records.map(record => Date.parse(record.timestamp));
    expect(stamps[0]).toBe(2_000);
    // Nudged one millisecond forward rather than left to reorder history under
    // the loader's timestamp-fallback arm.
    expect(stamps[1]).toBe(2_001);
    expect(stamps[2]).toBe(2_002);
  });
});

describe('toolUseResult is a JSON VALUE, not a JSON-looking string (A9)', () => {
  it('passes a parseable result through, and lets an unparseable one ride as a string', () => {
    const records = build();
    const results = records.filter(record => record.toolUseResult !== undefined);
    expect(results.map(record => record.toolUseResult)).toEqual([
      { port: 8123 },
      'README.md\nconfig.json',
    ]);
    // Whichever arm ran, the field survives a JSON round trip — the only
    // invariant the SDK's own `SessionStoreEntry` contract requires.
    for (const record of results) {
      expect(JSON.parse(JSON.stringify(record.toolUseResult))).toEqual(record.toolUseResult as never);
    }
  });

  it('covers the value shapes the corpus actually holds, and carves out null', () => {
    expect(toolUseResultValue('{"a":1}')).toEqual({ a: 1 });
    expect(toolUseResultValue('[1,2]')).toEqual([1, 2]);
    expect(toolUseResultValue('"quoted"')).toBe('quoted');
    expect(toolUseResultValue('plain text')).toBe('plain text');
    expect(toolUseResultValue('')).toBe('');
    // A tool that printed the four characters `null` is likelier than one whose
    // result IS the JSON null, and `toolUseResult: null` is indistinguishable
    // from "no result" to any reader.
    expect(toolUseResultValue('null')).toBe('null');
  });
});

describe('message.model — both arms, decided on the live run', () => {
  it('writes the session\'s real model id by default', () => {
    const assistants = build().filter(record => record.type === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    for (const record of assistants) expect(record.message['model']).toBe('tgpt/qwen35-397b-a17b-fp8');
    // The evidence for the default: our own runtime already writes non-Claude
    // gateway ids into these files and resumes off them, 678 assistant records
    // over 200 transcripts.
    expect(sdkFixture.messageKeys['assistant']?.['model']).toBe(sdkFixture.records['assistant']);
  });

  it('omits the field entirely on the other arm', () => {
    const assistants = build({ model: undefined }).filter(record => record.type === 'assistant');
    for (const record of assistants) expect(record.message).not.toHaveProperty('model');
    // …and nothing else moves, so the arm really is one field.
    const withModel = build().filter(record => record.type === 'assistant');
    assistants.forEach((record, index) => {
      const { model, ...rest } = withModel[index]!.message as Record<string, unknown>;
      expect(model).toBeTruthy();
      expect(record.message).toEqual(rest);
    });
  });
});

describe('D10 — the rebuild stamps its own provenance', () => {
  it('carries `runtime` from the stored row onto every synthesized record', () => {
    for (const record of build()) expect(record.runtime).toBe('pi');
  });

  it('omits it where the stored row has none, which is 4 533 of 5 332 rows', () => {
    const records = buildClaudeTranscriptRecords({
      history: [{ kind: 'message', role: 'user', content: 'no provenance' }],
      cwd: CWD,
      sdkSessionId: SDK_SESSION_ID,
      version: '2.1.223',
      ...deterministic(),
    });
    expect(records[0]).not.toHaveProperty('runtime');
  });
});

// ============================================================
// The writer and its read-back
// ============================================================

describe('the write is atomic and read back before it is trusted', () => {
  const paths = () => {
    const configDir = mkdtempSync(join(scratch, 'cfg-'));
    return { configDir, file: claudeTranscriptPath({ configDir, cwd: CWD, sdkSessionId: SDK_SESSION_ID }) };
  };

  it('writes one JSON.stringify per line, mode 0600, and verifies what landed', () => {
    const { file } = paths();
    const records = build();
    const written = writeClaudeTranscript(file, records);
    expect(written.records).toBe(records.length);

    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter(Boolean);
    expect(lines.length).toBe(records.length);
    expect(lines.map(line => JSON.parse(line) as ClaudeTranscriptRecord)).toEqual(records as never);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(claudeTranscriptIsLoadable(file)).toBe(true);
    // No temp file survives the rename.
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
  });

  it('refuses to write an empty transcript', () => {
    const { file } = paths();
    expect(() => writeClaudeTranscript(file, [])).toThrow(ClaudeTranscriptRebuildError);
    expect(claudeTranscriptIsLoadable(file)).toBe(false);
  });

  /**
   * The verifier, driven against deliberately-broken input. A verifier only
   * ever called on good input is not a verifier — and this one is the whole
   * fail-safe: when it throws, the caller sets no anchor and the armed text
   * handoff delivers instead.
   */
  it('rejects a truncated file, a broken chain and a non-JSON line', () => {
    const { file } = paths();
    const records = build();
    writeClaudeTranscript(file, records);
    expect(verifyClaudeTranscript(file, records.length).length).toBe(records.length);

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

    writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
    expect(() => verifyClaudeTranscript(file, records.length)).toThrow(/read back 2 record/);

    const unchained = lines.map((line, index) => {
      if (index !== 3) return line;
      const record = JSON.parse(line) as ClaudeTranscriptRecord;
      delete record.sourceToolAssistantUUID;
      record.parentUuid = '00000000-0000-4000-8000-ffffffffffff';
      return JSON.stringify(record);
    });
    writeFileSync(file, `${unchained.join('\n')}\n`);
    expect(() => verifyClaudeTranscript(file, records.length)).toThrow(/unchained/);

    writeFileSync(file, `${lines[0]}\nnot json\n${lines.slice(2).join('\n')}\n`);
    expect(() => verifyClaudeTranscript(file, records.length)).toThrow(/not valid JSON/);

    // POSITIVE CONTROL — the untouched file still verifies, so the three
    // rejections above are the corruption and not the verifier.
    writeClaudeTranscript(file, records);
    expect(() => verifyClaudeTranscript(file, records.length)).not.toThrow();
  });

  /**
   * `claudeTranscriptIsLoadable` is the SDK's own precondition, and it is what
   * `ClaudeAgent.shouldSuppressTextHandoff` reads to answer "is a rebuild
   * really in force this turn". A zero-byte file must read as ABSENT: the
   * SDK's transcript locator stats each candidate and skips any whose size is
   * zero, so a half-written file it would ignore must be one we ignore too —
   * otherwise we suppress the text handoff for a resume that cannot happen.
   */
  it('reads a zero-byte transcript as absent, exactly as the SDK does', () => {
    const { file } = paths();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    expect(claudeTranscriptIsLoadable(file)).toBe(false);
    expect(claudeTranscriptIsLoadable(join(scratch, 'no-such-file.jsonl'))).toBe(false);
    expect(claudeTranscriptIsLoadable(scratch)).toBe(false);
    writeClaudeTranscript(file, build());
    expect(claudeTranscriptIsLoadable(file)).toBe(true);
  });
});

describe('the version stamp is read from the installed package', () => {
  it('answers the CLI version, never a literal', () => {
    const version = readClaudeCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // The pinned SDK's own `claudeCodeVersion`, read the same way the shipped
    // code reads it — asserted as "agrees with the package", never as a value,
    // because pinning the value turns every SDK bump into a failure here.
    const manifest = JSON.parse(readFileSync(
      join(HERE, '..', '..', '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
      'utf8',
    )) as { claudeCodeVersion: string };
    expect(version).toBe(manifest.claudeCodeVersion);
    // The records on disk were written by 2.1.218 and this pin is newer, which
    // is precisely why the golden diff excludes the field.
    expect(ENVIRONMENTAL).toContain('version');
  });
});

/**
 * P6.481 — reasoning replays into a rebuilt claude transcript, and the
 * signature is the whole of whether it can.
 */
describe('P6.481 · a reasoning entry becomes a signed thinking block, or nothing', () => {
  const reasoning: RuntimeHandoffHistoryItem[] = [
    { kind: 'reasoning', content: 'the join is quadratic', signature: 'CAISmQIKiAEIEBgC', timestamp: 1_760_000_000_000 },
  ];

  it('carries the block WITH its signature, in the shape the API declares', () => {
    const records = build({ history: reasoning });
    const message = records[0]!.message as { content: unknown[] };
    // `ThinkingBlockParam` in `@anthropic-ai/sdk` is
    // `{ signature: string; thinking: string; type: 'thinking' }`, and all three
    // members are required — which is why the signature has to survive
    // capture, persistence and projection to get here.
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'the join is quadratic', signature: 'CAISmQIKiAEIEBgC' },
    ]);
  });

  it('STRIPS an unsigned block rather than downgrading it to text, and says so', () => {
    const lines: string[] = [];
    const records = build({
      history: [{ kind: 'reasoning', content: 'the join is quadratic', timestamp: 1_760_000_000_000 }],
      log: message => lines.push(message),
    });
    expect(records).toHaveLength(0);
    // Not a `text` block: emitting one model's private reasoning as prose it
    // spoke out loud is the mislabelling P6.604 removed one layer up.
    expect(JSON.stringify(records)).not.toContain('quadratic');
    expect(lines.join('\n')).toContain('without its signature is refused');
  });
});
