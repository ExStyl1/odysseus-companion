/**
 * P6.649 — an ordinary codex session resumes its OWN thread across a process
 * restart, instead of opening a fresh one behind a full transcript.
 *
 * ## What was wrong
 *
 * `thread/resume` had exactly one caller — P6.106's explicit `/resume` — so a
 * session reopened after a relaunch showed the user its whole transcript while
 * codex opened a FRESH thread that had seen none of it. Same "the model has not
 * seen this" shape P6.102 closed for branching, and the mechanism was already
 * wired: one guard away. Native-first case (1).
 *
 * ## Source-matched, for `codex-fork-thread-start-params.test.ts`' stated reason
 *
 * The three thread-open legs live inside a 6000-line class that needs an
 * app-server, a codex home and a live client to construct, and the proposition
 * here is about WHICH leg runs and in what order. A driven arm would be an
 * end-to-end relaunch, which this suite cannot stage; the residue is recorded in
 * the lane report rather than hidden.
 *
 * WHAT EACH TEST KILLS:
 *  - the caller arm dies if the persisted id stops being resumed — the shipped
 *    state.
 *  - the ORDER arms die if the new leg is placed ahead of the explicit `/resume`
 *    or the branch fork. Both of those name a SPECIFIC thread the user or the
 *    branch chose; "carry on where this session left off" must not outrank them.
 *  - the `threadResult` guard arm dies if the leg stops checking whether an
 *    earlier leg already opened a thread — which would fire a second
 *    `thread/resume` over a fork.
 *  - the fallback arms die if a refusal becomes fatal (a session that will not
 *    start) or becomes silent (a transcript the model cannot see, with nothing
 *    said).
 *  - the id-provenance arm dies if the leg starts reading anything but the id
 *    codex itself published.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

const at = (needle: string): number => {
  const index = SOURCE.indexOf(needle);
  expect(index, needle).toBeGreaterThan(0);
  return index;
};

describe('P6.649 · the persisted thread is resumed on relaunch', () => {
  it('reads the id codex itself published, not a host session id', () => {
    // `onSdkSessionIdUpdate` (P6.102) is what writes this field with codex's own
    // thread id. Anything else here would hand `thread/resume` an id no codex
    // thread has ever had — the exact `no rollout found` case the fork arm
    // documents.
    expect(SOURCE).toContain('const persistedThreadId = threadResult ? undefined : this.config.session?.sdkSessionId;');
  });

  it('calls thread/resume with it', () => {
    const guard = at('if (persistedThreadId) {');
    const call = at("threadResult = (await client.request('thread/resume', {");
    // The SECOND `thread/resume` call site: the first is P6.106's explicit
    // `/resume`. `lastIndexOf` is the new one.
    expect(SOURCE.lastIndexOf("client.request('thread/resume', {")).toBeGreaterThan(guard);
    expect(call).toBeGreaterThan(0);
  });

  it('runs AFTER the explicit /resume and AFTER the branch fork', () => {
    // Both of those name a specific thread a user or a branch chose; this leg
    // only means "carry on where this session left off".
    expect(at('const persistedThreadId')).toBeGreaterThan(at('if (this.resumeThreadId) {'));
    expect(at('const persistedThreadId')).toBeGreaterThan(at("client.request('thread/fork', {"));
  });

  it('runs BEFORE the fresh-thread fallback, which is what makes it reachable', () => {
    expect(at('const persistedThreadId'))
      .toBeLessThan(at("threadResult = (await client.request('thread/start', openThreadParams)) as OpenThreadResult;"));
  });

  it('does not fire over a thread an earlier leg already opened', () => {
    // The `threadResult ? undefined :` half. Without it a branch fork would be
    // followed by a resume of the PARENT id, discarding the fork.
    expect(SOURCE).toContain('threadResult ? undefined : this.config.session?.sdkSessionId');
  });
});

describe('P6.649 · a refusal is survivable and legible', () => {
  const armStart = () => at('const persistedThreadId');
  const armEnd = () => at("threadResult = (await client.request('thread/start', openThreadParams)) as OpenThreadResult;");
  const arm = () => SOURCE.slice(armStart(), armEnd());

  it('catches the refusal rather than letting it kill the session', () => {
    expect(arm()).toContain('} catch (error) {');
    // No re-throw inside the arm: the session must open either way.
    expect(arm()).not.toContain('throw error');
  });

  it('says so on the DURABLE channel, not only to debug', () => {
    // The user is looking at a transcript the model can no longer see, so a
    // debug line is not enough — the same channel the fork arm's refusal uses.
    expect(arm()).toContain('this.surfaceCodexOperatorNotice(');
    // D1.255 localised this notice with the fork arm's twin, so the sentence
    // left the source for `chat.codexNotice.threadResumeFailed` and the literal
    // pinned here could no longer be found in `codex-agent.ts` (red alone at
    // HEAD and on CI job 630520568). Both halves are pinned rather than one:
    // the ARM must reach the locale key, and the KEY must still say the thing
    // the case is named for. Dropping either half would let a notice that says
    // nothing, or a sentence nothing surfaces, pass.
    expect(arm()).toContain("i18n.t('chat.codexNotice.threadResumeFailed'");
    const en = JSON.parse(
      readFileSync(new URL('../../i18n/locales/en.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    expect(en['chat.codexNotice.threadResumeFailed'])
      .toContain('the model does not see the conversation above');
    expect(arm()).toContain('this.debug(');
  });

  it('does NOT narrow on the error message, unlike the fork arm', () => {
    // The fork arm re-throws anything that is not `no rollout found`, because a
    // branch that cannot fork is a different failure. Here every refusal has the
    // same consequence for the user, and re-throwing would turn a lost history
    // into a session that will not start.
    expect(arm()).not.toContain('no rollout found');
  });
});
