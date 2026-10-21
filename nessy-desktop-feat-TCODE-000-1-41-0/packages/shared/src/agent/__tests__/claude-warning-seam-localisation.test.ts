/**
 * C3.331 — the shared warning seam, and the line between its two halves.
 *
 * The controller's posture is LOCALISE. Measured at HEAD before anything was
 * built, the seam is NOT the four sentences the row names: `level: 'warning'`
 * occurs on 32 lines of `SessionManager.ts`, 12 of `claude-agent.ts`, 9 of
 * `codex-agent.ts` and 2 of `pi-agent.ts` (`grep -ac`, i.e. matching LINES,
 * 2026-09-13), plus a renderer bubble of its own that the row does not mention.
 * So the posture needs a RULE, not a list, and this suite is that rule's guard:
 *
 *  - the app's own words — anything addressed to the person in the chat —
 *    follow the UI language;
 *  - a verbatim quotation is not translated, because a translated quote is no
 *    longer a quote. That covers an upstream documentation sentence, a settings
 *    key an operator has to type, an SDK entry kind, and the vendor's own
 *    runtime message.
 *
 * Both arms are pinned here, because only one of them is visible in a diff: a
 * later lane localising a quoted sentence would look like it was finishing this
 * row, and nothing would have said otherwise.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claudeSessionPermissionUpdateBoundary,
  formatClaudeSdkShadowWarningNotice,
  formatClaudeSessionGrantRefusalNotice,
} from '../claude-agent.ts'

const agentDir = join(new URL('.', import.meta.url).pathname, '..')
const locales = join(agentDir, '..', 'i18n', 'locales')

function copy(file: string, key: string): string | undefined {
  const table = JSON.parse(readFileSync(join(locales, file), 'utf8')) as Record<string, string>
  return table[key]
}

describe('C3.331 — the app\'s own words follow the UI language', () => {
  it('the grant-refusal frame is composed from keys, and both locales carry them', () => {
    for (const key of [
      'chat.claudeGrantRefusal.stands',
      'chat.claudeGrantRefusal.standsWithForwarded',
      'chat.claudeGrantRefusal.dropped',
      'chat.claudeGrantRefusal.bypassNote',
      // UB14.14 — the renderer bubble's heading is v0.15.1's `chat.warning` (it retired ours).
      'chat.warning',
      'chat.warningBubble.attachmentsNotStored',
    ]) {
      for (const file of ['en.json', 'ru.json']) {
        expect(copy(file, key), `${file} is missing ${key}`).toBeTruthy()
      }
    }
  })

  it('NEGATIVE: no key takes `count`, which i18next would read as a plural selector', () => {
    // These keys deliberately carry no `…_one`/`…_other` family — the English
    // says "change(s)" — so a `count` interpolation would send i18next looking
    // for forms that do not exist.
    for (const file of ['en.json', 'ru.json']) {
      for (const key of ['chat.claudeGrantRefusal.standsWithForwarded', 'chat.claudeGrantRefusal.dropped']) {
        expect(copy(file, key)).not.toContain('{{count}}')
      }
      expect(copy(file, 'chat.warningBubble.attachmentsNotStored')).not.toContain('{{count}}')
    }
    const source = readFileSync(join(agentDir, 'claude-agent.ts'), 'utf8')
    expect(source).toContain("i18n.t('chat.claudeGrantRefusal.dropped', { dropped: refusals.length })")
  })

  it('the notice still renders as one line naming the tool, the survival and the refusal', () => {
    // The behaviour the localisation must not change: a refused GRANT is not a
    // refused APPROVAL, which is the whole reason the boundary reports at all.
    const verdict = claudeSessionPermissionUpdateBoundary([
      { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
      { type: 'addDirectories', destination: 'userSettings', directories: ['/srv/data'] },
    ])
    const notice = formatClaudeSessionGrantRefusalNotice({ toolName: 'Read', verdict })!
    expect(notice).toContain('Read')
    expect(notice).toContain('userSettings')
    expect(notice.includes('\n')).toBe(false)
    // And it is a SENTENCE, not a key: an uninitialized i18next returns
    // `undefined` from `t()`, so this is also the guard on the setup call.
    expect(notice).not.toContain('chat.claudeGrantRefusal')
    expect(notice).not.toContain('undefined')
  })
})

describe('C3.331 — a verbatim quotation stays verbatim', () => {
  const files = {
    'claude-default-mode-scope.ts': 'formatClaudeWideningDefaultModeRefusal',
    'claude-shell-command-settings.ts': 'formatClaudeShellCommandSettingRefusal',
    'claude-dangerous-mode-settings.ts': 'formatClaudeDangerousModeAckRefusal',
  } as const

  it('the three sibling refusals were read (the control for the assertion below)', () => {
    for (const [file, symbol] of Object.entries(files)) {
      expect(readFileSync(join(agentDir, file), 'utf8'), file).toContain(`export function ${symbol}(`)
    }
  })

  it('NEGATIVE: none of the three is localised, and that is the rule rather than a gap', () => {
    // Each quotes something that has exactly one spelling: an upstream
    // documentation sentence, a `.claude` settings key an operator types, a
    // settings file path. Translating those makes the refusal unactionable.
    // If this goes red, read `formatClaudeSessionGrantRefusalNotice`'s docblock
    // before "finishing" the localisation it deliberately stopped short of.
    for (const file of Object.keys(files)) {
      expect(readFileSync(join(agentDir, file), 'utf8'), file).not.toContain('i18n.t(')
    }
  })

  it('NEGATIVE: the vendor sentence the shadow warning relays is still passed through whole', () => {
    const source = readFileSync(join(agentDir, 'claude-agent.ts'), 'utf8')
    // `${message}` is the SDK's own text; a lead-in names what it means for this
    // product and the vendor's words are not rewritten. Since F1.596 that holds
    // for every arm but bypass — the case below. F1.638 reworded the lead-in (it
    // claimed the host gate was bypassed, measured false); the relay is unchanged.
    expect(source).toContain('`words: ${message}`')
  })

  it('F1.596 — the bypass arm quotes the DOCUMENTATION instead, and a quotation is still not translated', () => {
    // The SDK's bypass sentence is measured wrong about its own CLI (an ask-rule
    // call DOES reach canUseTool on 2.1.267), so that one arm quotes
    // `permission-modes.md` — an upstream documentation sentence, which is the
    // rule's second half by name. English, and a sentence rather than a key.
    const notice = formatClaudeSdkShadowWarningNotice(
      "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call.",
    )
    expect(notice).toContain('The actions no mode auto-approves still prompt in this mode."')
    expect(notice).toContain('permission-modes.md')
    expect(notice).not.toContain('canUseTool will not be invoked')
    // CONTROL: the other arm still carries the vendor's words whole.
    const relayed = formatClaudeSdkShadowWarningNotice('canUseTool will not be invoked for: Read.')
    expect(relayed).toContain('canUseTool will not be invoked for: Read.')
  })
})
/**
 * D1.148 — the SWEEP, and the one class of it that is already decided.
 *
 * C3.331 shipped the rule and applied it to the renderer half and to the one
 * host sentence in the second person; D1.148 is the remaining seam. Measured at
 * HEAD before this was written (`grep -ao … | wc -l`, occurrences, 2026-09-17,
 * on this rig): `i18n.t(` occurs 2 times in `codex-agent.ts`, 1 in
 * `pi-agent.ts`, 6 in `claude-agent.ts` and 23 in `SessionManager.ts`. The
 * codex half alone is ~28 `surfaceCodexOperatorNotice` call sites whose
 * sentences are long operator diagnostics embedding config keys, TOML values and
 * codex's own vocabulary — that is the row's remaining body, and it is a locale
 * job with an owner-visible cost rather than a mechanical sweep. It is NOT
 * pinned here, deliberately: a declared count would be a ratchet that reddens on
 * a sibling's commit, which is the failure AGENTS.md §Traps records.
 *
 * What IS decided, on all three runtimes, is the HOOK-RELAY class, and this
 * block is its guard. A hook's `systemMessage` is the hook AUTHOR's own words
 * arriving unannounced; the host frames it and relays it verbatim. The frame
 * carries no locale key because the text inside it cannot be translated, and a
 * translated frame around an untranslated sentence is half a sentence in each
 * language. D1.216 settled it on claude, codex's `surfaceHookUserFacingOutput`
 * had it first, and D1.238 applied the same string on pi — so all three now
 * compose it identically, which is the property a user switching runtimes meets.
 */
describe('D1.148 / C3.331 — a hook\'s own words are relayed, not translated', () => {
  const runtimes = ['claude-agent.ts', 'codex-agent.ts', 'pi-agent.ts'] as const

  it('all three runtimes compose the relay with the same frame', () => {
    for (const file of runtimes) {
      const source = readFileSync(join(agentDir, file), 'utf8')
      expect(source, file).toContain('hook: ${systemMessage}')
    }
  })

  it('NEGATIVE: none of the three wraps that frame in a locale key, and that is the rule', () => {
    // The mutant this kills is a later lane "finishing" D1.148 by localising the
    // frame: it would look like progress in a diff and would leave every user a
    // half-translated sentence. Read this block's docblock before doing it.
    for (const file of runtimes) {
      const source = readFileSync(join(agentDir, file), 'utf8')
      for (const line of source.split('\n')) {
        if (!line.includes('hook: ${systemMessage}')) continue
        expect({ file, line: line.trim() }).toEqual({ file, line: line.trim() })
        expect(line.includes('i18n.t('), `${file}: ${line.trim()}`).toBe(false)
      }
    }
  })

  it('POSITIVE CONTROL: the same instrument DOES see a localised line in this seam', () => {
    // Without this the case above would pass on a reader that never finds an
    // `i18n.t(` anywhere — an absence finding needs a positive control on the
    // same rig (AGENTS.md).
    const source = readFileSync(join(agentDir, 'claude-agent.ts'), 'utf8')
    const localised = source.split('\n').filter(line => line.includes('i18n.t('))
    expect(localised.length).toBeGreaterThan(0)
  })
})

/**
 * D1.255 / C3.331 — the CODEX half of D1.148's sweep, classified rather than
 * translated wholesale.
 *
 * ## What was measured before anything was written
 *
 * `surfaceCodexOperatorNotice` has 27 call sites (WI-v's census, re-read here):
 * one already localised, two hook relays pinned by the block above, three
 * delegating to a `describe*` helper, and ~21 in-place operator diagnostics.
 * The row asks for those ~21 to be read against C3.331's rule — and the rule
 * has TWO halves, so the answer is a classification, not twenty-one key pairs.
 *
 * **The app's own words follow the UI language.** Four sites are entirely ours,
 * about the app's own host, addressed to the person looking at the chat: the
 * callback bridge that did not start, the two thread arms that tell the user
 * the model cannot see the transcript above, and the `/clear` teardown. Those
 * are localised, with their interpolated id or error text passed through as
 * data.
 *
 * **A verbatim quotation is not translated, because a translated quote is no
 * longer a quote.** That is what the rest of the population is made of, and it
 * is stated here rather than assumed:
 *  - `noteCodexConfigWarningDiagnostic`, `noteCodexConfigWriterDiagnostic` and
 *    `noteCodexUnappliedRequirementDiagnostic` forward CODEX'S OWN message text
 *    behind a prefix gate — translating it would be paraphrasing another
 *    product's diagnostic.
 *  - `codex-agent-roles-unexpressible` / `-dropped`, the sandbox-policy
 *    mismatch, the compaction-settings notice and the claude-settings
 *    projection diagnostics are addressed to whoever administers a config file
 *    and name its keys and TOML tables (`[agents.<role>]`, `sandbox_mode`,
 *    `default_permissions`) — the same class C3.331 left English on claude.
 *
 * ## The TWIN CONSTRAINT, which is why one obvious candidate is NOT localised
 *
 * `Codex worker is shutting down (runtime_restart).` is worded character for
 * character as claude's `Claude worker is shutting down (<reason>).` and pi's
 * twin, deliberately, so a user who switches runtimes reads ONE sentence.
 * Localising it alone would break exactly the property it was written for, so
 * it moves when all three move, in one commit, or not at all. The case below
 * pins that.
 */
describe('D1.255 / C3.331 — the codex operator seam, classified', () => {
  const codex = () => readFileSync(join(agentDir, 'codex-agent.ts'), 'utf8')

  it('the four chat-addressed notices are composed from keys, present in both locales', () => {
    const source = codex()
    for (const key of [
      'chat.codexNotice.callbackBridgeUnavailable',
      'chat.codexNotice.threadForkFailed',
      'chat.codexNotice.threadResumeFailed',
      'chat.codexNotice.clearTeardownFailed',
    ]) {
      expect(source, key).toContain(`i18n.t('${key}'`)
      for (const file of ['en.json', 'ru.json']) {
        const text = copy(file, key)
        expect({ key, file, present: typeof text === 'string' && text.length > 0 })
          .toEqual({ key, file, present: true })
      }
    }
  })

  it('the English sentences the row replaced are GONE from the source', () => {
    // MUTATION KILLED: adding the keys and leaving the literals behind, which
    // reads as done in a diff and ships the English to every user.
    const source = codex()
    for (const fragment of [
      'the host callback bridge ',
      'Codex could not fork the parent thread (',
      "Codex could not resume this session's thread (",
      'could not shut its app-server down cleanly on /clear',
    ]) {
      expect({ fragment, present: source.includes(fragment) }).toEqual({ fragment, present: false })
    }
  })

  it('NEGATIVE: the runtime-switch TWIN sentence is still English, in all three runtimes', () => {
    // The property is "one sentence per user across a runtime switch", so this
    // line cannot be localised on codex alone. The three files must agree.
    for (const file of ['codex-agent.ts', 'claude-agent.ts', 'pi-agent.ts'] as const) {
      const source = readFileSync(join(agentDir, file), 'utf8')
      for (const line of source.split('\n')) {
        if (!line.includes('worker is shutting down')) continue
        expect(line.includes('i18n.t('), `${file}: ${line.trim()}`).toBe(false)
      }
    }
    // POSITIVE CONTROL for the needle: the sentence exists to be found.
    expect(codex()).toContain('Codex worker is shutting down (runtime_restart).')
  })

  it('NEGATIVE: codex\'s OWN forwarded diagnostics are not wrapped in a key', () => {
    // The three prefix-gated forwarders relay another product's message text.
    // A key here would be a paraphrase of a diagnostic we did not write.
    const source = codex()
    for (const method of [
      'noteCodexConfigWarningDiagnostic',
      'noteCodexConfigWriterDiagnostic',
      'noteCodexUnappliedRequirementDiagnostic',
    ]) {
      const at = source.indexOf(`private ${method}(message: string): void {`)
      expect({ method, found: at > -1 }).toEqual({ method, found: true })
      const body = source.slice(at, source.indexOf('\n  }', at))
      expect(body.includes('i18n.t('), method).toBe(false)
      expect(body, method).toContain('this.surfaceCodexOperatorNotice(message)')
    }
  })
})

/**
 * D1.286 — the ATTACHMENT twin, pinned where a lane localising a sentence looks.
 *
 * ## The premise, corrected by measurement
 *
 * The row asks for "one test asserting the three sentences stay identical".
 * There are TWO, and the third runtime is a CONTROL rather than a third copy:
 * `pi-agent.ts` and `codex-agent.ts` each warn that a PDF was carried as a path,
 * worded as each other's twin on purpose, and `claude-agent.ts` carries no such
 * sentence at all — it carries the BYTES, which is what both twins tell the user
 * to switch to. A pin that expected a claude copy would be asking for a sentence
 * whose existence would mean the feature had regressed.
 *
 * And a cross-file assertion already exists, in
 * `pi-attachment-uncarried-documents.test.ts` — a file named for Pi, whose
 * docblock frames itself as "the Pi half". Localising either sentence alone
 * already turns its `toContain` red. What that cannot do is tell the lane WHY:
 * a red in a Pi attachment suite reads as a Pi attachment defect, not as the
 * twin constraint C3.331 is about. This pin lives beside the shutdown twin, in
 * the suite a lane reaches for when it localises anything, and it states the
 * constraint in its own words.
 *
 * ## The constraint, in the shutdown twin's own shape
 *
 * One sentence per user across a runtime switch. So the clause cannot be
 * localised on one runtime alone: the two files move together, in one commit, or
 * not at all.
 */
describe('D1.286 / C3.331 — the attachment twin is ONE sentence on both silent runtimes', () => {
  /** The clauses the two files share verbatim; each runtime names itself between them. */
  const SHARED_CLAUSES = [
    'sent as a file path only — ',
    'contents, and neither can ',
    "The Claude runtime carries a PDF's bytes to the model: ",
  ] as const;

  const read = (file: string): string => readFileSync(join(agentDir, file), 'utf8');

  it('pi and codex carry all three clauses, and claude carries none of them', () => {
    for (const clause of SHARED_CLAUSES) {
      for (const file of ['pi-agent.ts', 'codex-agent.ts'] as const) {
        expect({ file, clause, present: read(file).includes(clause) })
          .toEqual({ file, clause, present: true });
      }
      // THE CONTROL, and it is a claim about the product rather than a tidy
      // absence: claude carries the bytes, so it has nothing to warn about. A
      // claude copy of this sentence would mean that stopped being true.
      expect({ clause, presentOnClaude: read('claude-agent.ts').includes(clause) })
        .toEqual({ clause, presentOnClaude: false });
    }
  });

  it('NEGATIVE: neither twin is localised, because localising one alone breaks the property', () => {
    // Read per LINE, as the runtime-switch twin above is: the clause is built by
    // string concatenation across three source lines, and a file-wide check for
    // `i18n.t(` would answer about the whole agent instead of about this warning.
    for (const file of ['pi-agent.ts', 'codex-agent.ts'] as const) {
      const lines = read(file).split('\n').filter(line => SHARED_CLAUSES.some(c => line.includes(c)));
      // POSITIVE CONTROL for the needle: a filter that matched nothing would
      // make the assertion below vacuous, which is how an absence goes quiet.
      expect({ file, matched: lines.length }).toEqual({ file, matched: SHARED_CLAUSES.length });
      for (const line of lines) {
        expect(line.includes('i18n.t('), `${file}: ${line.trim()}`).toBe(false);
      }
    }
  });
});
