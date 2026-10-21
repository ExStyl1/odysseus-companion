/**
 * F1.233 (origin WJ-l P-WJ-l-6) + F1.387 (origin the WJ-hh verifier on F1.233,
 * "F1.233-c"; DECIDED 2026-09-23: state it in the toggle copy) — the Codex
 * auto-review toggle says what its reviewer can approve that this app would
 * otherwise refuse or put in front of a person, and says what it cannot reach.
 *
 * ## Read at `openai/codex@rust-v0.154.0` before deciding (read-don't-invent)
 *
 * - An approval codex raises goes through `Session::request_approval`
 *   (`core/src/tools/approvals.rs`), whose order is "1. Hooks 2. If
 *   StrictAutoReview || Guardian enabled, then Guardian. Else, user." With the
 *   reviewer on, the guardian decides and this app — the "user" arm — is never
 *   asked, so everything the approval bridge would REFUSE is the reviewer's to
 *   approve: the non-negotiable floors (`floorVerdict`, the root/home removal
 *   breaker among them), the P6.62 `deniedPaths` refusal, and every deny rule
 *   codex does not enforce itself. F1.370 measured the MCP half on the shipped
 *   binary (`mcp/__tests__/codex-mcp-tool-levers-live.test.ts`).
 * - What survives, and the copy may therefore not claim is lost: a rule codex
 *   enforces ITSELF. A bash deny prefix projected as `decision="forbidden"`
 *   (P2.141b) is `ExecApprovalRequirement::Forbidden`, which
 *   `core/src/tools/orchestrator.rs` rejects before any approval — MEASURED in
 *   the same live suite (F1.387's CONTROL: refused, no reviewer request, no host
 *   request); an exact-name `mcp__` deny/ask is codex's own `disabled_tools` /
 *   `approval_mode = "prompt"` since F1.378.
 * - Two reaches closed since F1.233 and stated as such: explore and plan turns
 *   carry `approvalsReviewer: 'user'` (F1.373), and a change to what an
 *   unattended automation does or when it runs is refused by a host-authored
 *   `PermissionRequest` hook BEFORE the reviewer (F1.386, measured on the
 *   binary) — so the old "no way to send one call past its reviewer" is false
 *   and must not come back.
 */
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const KEY = 'settings.ai.codexAutoReview.enabledDesc'
const text = (bundle: unknown): string => (bundle as Record<string, string>)[KEY] ?? ''

describe('F1.233 + F1.387 · the auto-review toggle states what its reviewer can approve', () => {
  it('en names the refusals the reviewer can overrule — the floors, denied paths, the rules codex cannot enforce — and why', () => {
    const desc = text(en)
    expect(desc).toContain('can also approve what this app would otherwise refuse or always put in front of you')
    expect(desc).toContain('removing your home or root folder')
    expect(desc).toContain('the paths you have denied')
    expect(desc).toContain('any deny rule Codex cannot enforce itself')
    expect(desc).toContain('because Codex asks its reviewer before it asks this app')
  })

  it('en states the two reaches that are closed (F1.373, F1.386)', () => {
    const desc = text(en)
    expect(desc).toContain('never asked in Plan or Don\'t ask.') // F1.1052: Explore is retired (F1.1050); F1.1056: Don't ask
    expect(desc).toContain('unattended automation does or when it runs is refused instead of reviewed')
  })

  it('ru says the same', () => {
    const desc = text(ru)
    expect(desc).toContain('может одобрить и то, что приложение иначе отклонило бы')
    expect(desc).toContain('удаление домашней или корневой папки')
    expect(desc).toContain('запрещённые вами пути')
    expect(desc).toContain('которое Codex не применяет сам')
    expect(desc).toContain('в режимах «План» и «Не спрашивать» проверяющего не спрашивают') // F1.1052: Explore retired; F1.1056
    expect(desc).toContain('автоматизации без присмотра отклоняется, а не проверяется')
  })

  // F1.1169 (controller decision 2026-09-29) — the reviewer answers only in Auto and, as the operator's safety
  // net, in Bypass permissions; Manual and Accept edits ask the user. The copy names the modes, in each locale's
  // own mode labels (`mode.*`), and no longer claims the reviewer answers in every mode but Plan.
  it('F1.1169: both locales name the modes the reviewer answers in, and the modes that ask the user', () => {
    expect(text(en)).toContain('In Auto, and in Bypass permissions as a safety net,')
    expect(text(en)).toContain('In Manual and Accept edits it asks you')
    expect(text(ru)).toContain('В режимах «Авто» и, как страховка, «Обход разрешений»')
    expect(text(ru)).toContain('В режимах «Ручной» и «Принять правки» он спрашивает вас')
    for (const bundle of [en, ru]) {
      const labels = bundle as Record<string, string>
      for (const key of ['mode.auto', 'mode.default', 'mode.acceptEdits', 'mode.plan', 'mode.dontAsk']) {
        expect(text(bundle)).toContain(labels[key]!)
      }
      // The scope also leads the section's own one-line description.
      expect(labels['settings.ai.codexAutoReview.description']).toContain(labels['mode.bypassPermissions']!)
    }
    // CONTROL: the sentence the old scope needed is gone — the hook's refusal is no longer "outside Bypass".
    expect(text(en)).not.toContain('outside Bypass a change')
  })

  // F1.1198 — native-first: an administrator's allowed_approvals_reviewers is codex's own and wins, so under a
  // reviewer-only list the "asks you" and "never asked" sentences above have an exception, and the copy names it.
  it('F1.1198: both locales name the administrator-list exception right after the per-mode sentence', () => {
    expect(text(en)).toContain('never asked in Plan or Don\'t ask. If your organisation\'s Codex policy allows only the reviewer, that policy wins: the reviewer answers in Manual, Accept edits and Don\'t ask too, Codex refuses Plan turns')
    expect(text(ru)).toContain('проверяющего не спрашивают. Если политика Codex вашей организации разрешает только проверяющего, решает она: проверяющий отвечает и в режимах «Ручной», «Принять правки» и «Не спрашивать», Codex отклоняет ходы «План»')
  })

  it('the sentence F1.386 made false is gone from both locales', () => {
    expect(text(en)).not.toContain('no way to send one call past its reviewer')
    expect(text(ru)).not.toContain('нет способа провести отдельный вызов мимо проверяющего')
  })

  it('CONTROL: the description keeps what it already promised (/approve)', () => {
    expect(text(en)).toContain('/approve')
    expect(text(ru)).toContain('/approve')
  })

  // F1.388 (origin the WJ-hh verifier on F1.233) — a run of denials INTERRUPTS
  // the turn; it never hands the turn back to a person. At `rust-v0.154.0`
  // `GuardianRejectionCircuitBreakerAction` is only `Continue | InterruptTurn`
  // (`core/src/guardian/mod.rs`), and `record_guardian_denial`
  // (`core/src/guardian/review.rs`) warns "…; interrupting the turn." and then
  // `abort_turn_if_active(…, TurnAbortReason::Interrupted)`. The assertion is
  // the NEW wording being present, never the old phrase staying.
  it('F1.388: en and ru say a run of denials interrupts the turn', () => {
    expect(text(en)).toContain('a run of denials interrupts the turn')
    expect(text(ru)).toContain('череда отказов прерывает ход')
  })

  // F1.534 (origin WJ-at P-WJat-2) — since F1.532 the floor hook gives no verdict
  // in Bypass (Bypass skips that floor on every runtime), so there the reviewer
  // answers a change to an unattended automation, and it still answers whatever
  // Codex raises in Bypass. The sentence above ("refused instead of reviewed")
  // was true in every mode before F1.532 and is now true outside Bypass only.
  // F1.1169: the reviewer now answers in Auto and Bypass only, so "outside Bypass" is Auto.
  it('F1.534: en and ru say the reviewer still answers in Bypass, and bound the automation floor to Auto', () => {
    expect(text(en)).toContain('In Bypass it still answers what Codex raises')
    expect(text(en)).toContain('in Auto a change to what an unattended automation does')
    expect(text(ru)).toContain('В режиме «Обход» он по-прежнему отвечает на то, что поднимает Codex')
    expect(text(ru)).toContain('в режиме «Авто» изменение действий или расписания автоматизации')
  })

  // F1.1082 (origin DN-030) — F1.781 (dff27eed3) made OFF reach a live codex session from its next turn (a
  // per-turn `approvalsReviewer: 'user'`), and kept ON — with `[auto_review].policy` — next-session on purpose:
  // the floor hook and the policy exist only in a config written with the reviewer on. The copy says when each
  // change applies, right after "Off by default.".
  it('F1.1082: both locales say OFF applies from the next message and ON (and the policy) to new sessions', () => {
    expect(text(en)).toContain('Off by default. Turning it off applies from the next message in open Codex sessions; turning it on, and a change to the reviewer policy, applies to Codex sessions started afterwards.')
    expect(text(ru)).toContain('По умолчанию выключено. Выключение действует со следующего сообщения в открытых сессиях Codex; включение и изменение политики проверяющего действуют в сессиях Codex, начатых после этого.')
    // CONTROL: the live-OFF half is not claimed for ON — no "takes effect immediately" for the reviewer.
    expect(text(en)).not.toContain('applies immediately')
  })
})
