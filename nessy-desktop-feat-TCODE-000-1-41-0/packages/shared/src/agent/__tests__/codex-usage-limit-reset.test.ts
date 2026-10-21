/**
 * P6.503, codex arm — a codex turn that dies on a usage limit says plainly that
 * no reset was published, instead of stopping silently.
 *
 * The vocabulary and its unit arms are `usage-limit-reset.test.ts`. This file is
 * the codex WIRING: the clause is attached to the usage-limit error and to no
 * other, and the source is read for the emit site so the helper cannot exist
 * while nothing calls it.
 *
 * ## Why the codex arm has nothing to wait on today
 *
 * `CodexErrorInfo` at `rust-v0.148.0` types `usageLimitExceeded` as a BARE
 * STRING — one of the plain variants, not one of the object variants carrying
 * `httpStatusCode` — so the signal that stops the turn carries no timestamp.
 * The reset codex does publish rides `RateLimitWindow.resetsAt`, which F1.7
 * holds for a session signed in to an account; F1.569 pairs the full window's
 * reset with the stop on the ChatGPT (Codex) card
 * (`codex-usage-limit-window-reset.test.ts`). The clause still ASKS the error for
 * a reset first, so a codex release that starts stamping one is reported.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODEX_UNREAD_NOTIFICATION_METHODS } from '../codex-notification-families.ts';
import { codexUsageLimitResetClause } from '../usage-limit-reset.ts';

/** The REAL exported function, not a copy — the whole reason it is exported. */
const clause = (error: { codexErrorInfo?: unknown; resetsAt?: unknown } | undefined): string =>
  codexUsageLimitResetClause(
    typeof error?.codexErrorInfo === 'string'
      ? error.codexErrorInfo
      : error?.codexErrorInfo && typeof error.codexErrorInfo === 'object'
        && Object.keys(error.codexErrorInfo).length === 1
        ? Object.keys(error.codexErrorInfo)[0]
        : undefined,
    error?.resetsAt,
  );

const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

describe('P6.503 · the codex emit site carries the clause', () => {
  it('appends it to the turn-error message the user sees', () => {
    expect(SOURCE).toContain('const resetClause = codexUsageLimitResetClause(');
    // The clause must reach the message the user actually sees, not merely be
    // computed: a helper nothing forwards is the defect wearing a fix.
    expect(SOURCE).toContain("message: `codex: ${text}${resetClause}` });");
  });

  it('reads the code with the file\'s own union reader rather than a second copy', () => {
    // `CodexErrorInfo` is a string for the plain variants and a single-key object
    // for the ones carrying an HTTP status. A second reader here would drift.
    expect(SOURCE).toContain('readCodexErrorInfoCode(codexError?.codexErrorInfo)');
  });
});

describe('P6.503 · the clause fires for the usage limit and for nothing else', () => {
  it('says the turn stops when codex published no reset', () => {
    expect(clause({ codexErrorInfo: 'usageLimitExceeded' }))
      .toContain('No reset time was published');
  });

  it('stays EMPTY for every other codex error code', () => {
    for (const code of ['serverOverloaded', 'internalServerError', 'contextWindowExceeded', 'other']) {
      expect(clause({ codexErrorInfo: code })).toBe('');
    }
    // The object variants too — `{ httpConnectionFailed: { httpStatusCode } }`
    // is a single-key object, so a careless code reader would name the wrong
    // thing here.
    expect(clause({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } })).toBe('');
    expect(clause({})).toBe('');
    expect(clause(undefined)).toBe('');
  });
});

describe('P6.503 · the premise this arm rests on is still true', () => {
  it('the ERROR that stops the turn still carries no reset, so the clause stays true', () => {
    // This pin used to be "`account/rateLimits/updated` is still unread", and it
    // said it would fail the day a lane read it — F1.7 is that lane, so it was
    // revisited rather than deleted. The clause is about the ERROR: "No reset
    // time was published with this limit". F1.7 reads the window notification
    // into the windows it holds, and the stopping signal is a BARE STRING at the
    // pinned tag, so the sentence stays true where no window is held. The
    // session that DOES hold codex's windows when the turn stops — the ChatGPT
    // (Codex) card, F1.202 — is paired by F1.569
    // (`codex-usage-limit-window-reset.test.ts`), not by this clause's input.
    const codexErrorInfo = readFileSync(
      fileURLToPath(new URL('../../../../codex-protocol/generated/v2/CodexErrorInfo.ts', import.meta.url)),
      'utf8',
    );
    expect(codexErrorInfo).toContain('"usageLimitExceeded" |');
    expect(codexErrorInfo).not.toContain('"usageLimitExceeded":');
    // The notification really is READ now — the half that moved.
    expect(CODEX_UNREAD_NOTIFICATION_METHODS).not.toContain('account/rateLimits/updated' as never);
    // Positive control: the list is the real one, not an empty array.
    expect(CODEX_UNREAD_NOTIFICATION_METHODS.length).toBeGreaterThan(10);
  });
});
