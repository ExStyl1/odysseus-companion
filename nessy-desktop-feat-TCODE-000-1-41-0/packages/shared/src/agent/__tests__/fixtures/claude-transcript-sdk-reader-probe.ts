/**
 * P3.269 — the agreement probe for `claude-transcript-rebuild.ts`, run in a
 * CHILD so the verdict is the SDK's and the rig is nobody else's.
 *
 * ## Why a child process and not an import
 *
 * The three SDK readers (`getSessionMessages`, `listSessions`, `getSessionInfo`)
 * resolve their projects root from `process.env.CLAUDE_CONFIG_DIR` through a
 * value-keyed memoize (`sdk.mjs`: `var Gt=yu(()=>(TD()??$X(jX(),".claude"))
 * .normalize("NFC"),TD)`). That is PROCESS-GLOBAL state, and the host points
 * each workspace's SDK child at its own config dir rather than the host process
 * — so a test that set the variable in the runner would be mutating a global
 * every other suite in that process shares. A child is the only rig where the
 * variable can be set honestly.
 *
 * ## AGENTS.md: every side effect behind `import.meta.main`
 *
 * A fixture whose module body runs on import kills the runner at import time and
 * reports exit 0 with zero tests executed. The test imports nothing from here —
 * it spawns this file — but the guard is unconditional anyway, because that
 * failure mode is invisible in the exit status.
 *
 * Prints one JSON line on stdout. Every failure is a non-zero exit with the
 * reason on stderr, so the test never has to interpret silence.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeTranscriptSdkReaderProbeResult {
  /**
   * Which arm of `claudeProjectKey` this run exercised.
   *
   * `'short'` sanitizes to <= 200 characters and never touches the djb2 hash;
   * `'hashed'` exceeds it and therefore ends in `-<base36 djb2 of the ORIGINAL
   * path>`. A re-break proved the distinction is not academic: mutating the
   * hash left a probe that only ran the short arm entirely green, because the
   * hash is dead code on a short path.
   */
  arm: 'short' | 'hashed';
  /** The sanitized project-key directory name the host derived. */
  projectKey: string;
  /** The path the HOST derived, from its own djb2 + NFC + sanitizer. */
  hostPath: string;
  /** Records the host wrote. */
  hostRecords: number;
  /** Messages the SDK's own reader recovered from that file. */
  sdkMessages: number;
  /** Roles, in order, as the SDK chained them. */
  sdkRoles: string[];
  /** Sessions the SDK listed for that project directory. */
  sdkListed: number;
  /** The session id the SDK found — must be the one the host minted. */
  sdkSessionIdFound: string | null;
  /** The cwd the SDK read back out of the file. */
  sdkCwd: string | null;
  /** The cwd the host wrote, for the comparison the test makes. */
  hostCwd: string;
  /** The id the host minted. */
  sdkSessionId: string;
}

export async function runClaudeTranscriptSdkReaderProbe(
  arm: 'short' | 'hashed' = 'short',
): Promise<ClaudeTranscriptSdkReaderProbeResult> {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-w2b-claude-cfg-'));
  const root = mkdtempSync(join(tmpdir(), 'nessy-w2b-claude-cwd-'));
  // THE HASHED ARM IS THE ONE THAT COVERS THE djb2.
  //
  // `claudeProjectKey` appends `-<hash>` only once the sanitized path passes
  // `CLAUDE_PROJECT_KEY_MAX_LENGTH` (200). A probe run under a bare `mkdtemp`
  // path is ~40 characters, so it exercises the sanitizer and the NFC gate and
  // NEVER the hash — measured by a mutation that changed the hash's shift and
  // left the whole suite green. This nests until the resolved path is long
  // enough that the suffix is reached.
  let cwd = root;
  if (arm === 'hashed') {
    while (realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-').length <= 200) {
      cwd = join(cwd, 'deep-enough-to-pass-the-two-hundred-character-ceiling');
      mkdirSync(cwd, { recursive: true });
    }
  }

  // `delete` first, then assign — AGENTS.md's Bun env rule, applied
  // unconditionally rather than gated on a name list that cannot be complete.
  delete (process.env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const rebuild = await import('../../claude-transcript-rebuild.ts');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const sdkSessionId = rebuild.mintClaudeSdkSessionId();
  const records = rebuild.buildClaudeTranscriptRecords({
    sdkSessionId,
    cwd,
    version: '0.0.0-probe',
    history: [
      { kind: 'message', role: 'user', content: 'hello from the host' },
      { kind: 'message', role: 'assistant', content: 'and back from the model' },
    ],
    model: 'claude-sonnet-5',
  });
  const hostPath = rebuild.claudeTranscriptPath({ configDir, cwd, sdkSessionId });
  rebuild.writeClaudeTranscript(hostPath, records);

  const messages = await sdk.getSessionMessages(sdkSessionId, { dir: cwd });
  const listed = await sdk.listSessions({ dir: cwd });
  const info = await sdk.getSessionInfo(sdkSessionId, { dir: cwd });

  const projectKey = rebuild.claudeProjectKeyForCwd(cwd);
  return {
    arm,
    projectKey,
    hostPath,
    hostRecords: records.length,
    sdkMessages: messages.length,
    sdkRoles: messages.map(message => String((message as { type?: unknown }).type ?? '?')),
    sdkListed: listed.length,
    sdkSessionIdFound: info?.sessionId ?? null,
    sdkCwd: info?.cwd ?? null,
    hostCwd: cwd,
    sdkSessionId,
  };
}

if (import.meta.main) {
  const requested = process.argv[2] === 'hashed' ? 'hashed' : 'short';
  runClaudeTranscriptSdkReaderProbe(requested)
    .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
