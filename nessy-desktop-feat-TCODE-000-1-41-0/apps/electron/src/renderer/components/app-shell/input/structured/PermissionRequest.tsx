/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx (UB14.24; the
 * decision anatomy ADDED in v0.15.0). Merged per hunk (Apache-2.0), LOOK only: upstream's anatomy — the Hand /
 * TriangleAlert tile, the tool name in mono, the risk pills, the command in `DecisionPreview`, Allow primary ·
 * Always Allow secondary · `DecisionSpacer` · Deny ghost, the tip in `DecisionFoot` — with every one of OUR card
 * variants re-applied on it, behaviour unchanged: outside-root (P6), the first-outside-read three answers
 * (P6.202), artifact publish (UA1.18), reopen compact / don't-ask (P6.500/P6.950), worktree cleanup (P6.135),
 * "Yes, and switch to auto mode" (P6.208), the subagent label, the impact block (now inside `DecisionDetails`,
 * still above the preview), the session-only Always Allow labels and per-runtime sentences (C3.365, D1.262,
 * F1.1236, UA12.105), the answer note (P6.951/P6.864), `defaultToNo` (F1.1219), and `canRemember` from OUR
 * wire's `noAlwaysAllow` (UB1.2; upstream reads a `canRemember` field ours does not carry). The exported pure
 * helpers above the component are untouched.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Hand, MessageSquarePlus, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
// `PermissionRequestOrigin` comes from `@nessy-agent/core/types` rather than
// from `shared/types`: `dto.ts` re-exports the permission REQUEST but not the
// origin vocabulary, and `@nessy-agent/core/types` is an existing exports-map
// key this renderer already imports from.
import type { PermissionRequestOrigin } from '@nessy-agent/core/types'
import type { PermissionRisk } from '@nessy-agent/core/types'
import {
  bashAlwaysAllowRuleContent,
  bashSessionWhitelistKey,
  headNamesCommandInterpreter,
  headsDangerousCommandPair,
  isDangerousCommandLine,
} from '@nessy-agent/shared/agent/core/dangerous-commands'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types'
import { useComposerCapabilities } from '../composer-capabilities-context'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import type { PermissionResponse } from './types'
import { bashAlwaysAllowRememberScope } from '@nessy-agent/shared/agent/core/bash-remember-scope'
import { ArtifactPublishDetails } from './ArtifactPublishDetails'
import { knownPermissionRisks } from './decision-tone'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionFoot,
  DecisionHeader,
  DecisionPreview,
  DecisionSpacer,
  type DecisionTone,
} from './DecisionCard'
interface PermissionRequestProps {
  request: PermissionRequestType
  onResponse: (response: PermissionResponse) => void
  /** When true, the composer slot (InputContainer) draws the card material and ring */
  unstyled?: boolean
  /** The mode the session is in right now — the composer's own value. */
  permissionMode?: PermissionMode
  /** The composer's mode setter, so the card can approve AND switch in one click. */
  onPermissionModeChange?: (mode: PermissionMode) => void
}

/** Inputs of {@link shouldOfferAutoModeSwitch}. */
export interface AutoModeSwitchInputs {
  type?: PermissionRequestType['type']
  origin?: PermissionRequestOrigin
  permissionMode?: PermissionMode
  /**
   * P6.863 — the permission MODE alone raised this prompt, so a mode change can
   * remove it. Absent means UNKNOWN; see the field's own docblock in
   * `core/types/message.ts`.
   */
  modePrompt?: true
  /** The modes this connection actually offers (`ComposerCapabilities.permissions.modes`). */
  availableModes: readonly PermissionMode[]
}

/**
 * P6.208 (A40) — may this card offer **Yes, and switch to auto mode**?
 *
 * `permission-modes.md#switch-permission-modes`, verbatim: *"**From a Bash
 * permission prompt**: in the Manual and `acceptEdits` permission modes, when
 * auto mode is available, Claude Code adds **Yes, and switch to auto mode** to a
 * Bash command's permission prompt. Select it to approve the command and switch
 * the session to auto mode. PowerShell tool prompts don't offer the option."*
 * And the carve-out, same section: *"Claude Code doesn't add the option to
 * prompts forced by one of your `ask` rules or by a hook, because auto mode
 * still shows you those prompts, so switching wouldn't remove them."*
 *
 * Four conditions, and the fourth is the only one that needed a wire field:
 *
 *  1. **A Bash command's prompt.** The page scopes the affordance to `bash`;
 *     nothing else gets it.
 *  2. **Manual or acceptEdits.** `default` IS Manual — that is the mode's
 *     spelling on this product, not a synonym invented here.
 *  3. **Auto mode is available**, read from the composer's own capability list,
 *     so the button can never offer a mode the mode picker refuses.
 *  4. **Not forced by an ask rule or a hook**, read from `origin` (P6.709).
 *
 * **PowerShell needs no condition and that is a measurement, not an omission**
 * (recorded on `PermissionRequestType` in `core/types/message.ts`): P6.530 pins
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL` to the documented off value in every claude
 * child, so the tool is never constructed, Pi and codex have no counterpart, and
 * `toolName: 'PowerShell'` is 0 occurrences in the tree. The carve-out is
 * satisfied by construction; a branch for it would test a prompt this product
 * cannot produce.
 *
 * ## Why `origin !== 'host_gate'` and not something finer
 *
 * `host_gate` is every prompt OUR gate raised — which is a superset of "forced
 * by an ask rule or a hook": it also covers ordinary MODE prompts, and the seven
 * host-owned surfaces (Monitor, `archive_session`, the cross-session dialog, the
 * plugin-hook and skill-context Bash gates, composer `!`) that auto mode would
 * indeed still show. So this test is CONSERVATIVE in the safe direction: it can
 * hide the option where it would have been legal, and it can never offer it on a
 * prompt the page says must not carry it.
 *
 * ## P6.863 closed that residue, and it is a PRODUCER field, not a renderer one
 *
 * `runPreToolUseChecks` already computed the exact discriminant —
 * `PreToolUseCheckResult`'s `nonNegotiable: 'askRule' | …`, whose own docblock
 * says it is *"Absent on ordinary mode prompts"* — and it stopped at the
 * producer, so a mode-driven Pi prompt (and claude's PreToolUse-branch prompt,
 * which is `host_gate` wearing claude's clothes) was hidden along with the
 * rule-forced ones: the two places where switching to auto mode WOULD remove the
 * prompt. Both gate sites now say so with `modePrompt`.
 *
 * The `host_gate` conservatism above is unchanged and still load-bearing: the
 * widening is `modePrompt === true`, not `origin === 'host_gate'`. The seven
 * host-owned surfaces never pass through the gate, so they never set the field,
 * and an unknown origin still manufactures nothing.
 */
export function shouldOfferAutoModeSwitch({
  type,
  origin,
  modePrompt,
  permissionMode,
  availableModes,
}: AutoModeSwitchInputs): boolean {
  if (type !== 'bash') return false
  if (permissionMode !== 'default' && permissionMode !== 'acceptEdits') return false
  if (!availableModes.includes('auto')) return false
  // Absent means UNKNOWN, never "the host did not raise it" — the same reading
  // P6.709 gave the field at the band, and the only safe one here: an unknown
  // origin must not manufacture an affordance the page forbids.
  if (origin === 'claude_native' || origin === 'codex_approval') return true
  // P6.863 — and the gate's own mode prompts, which the page's carve-out is
  // explicitly NOT about: it excludes prompts "forced by one of your `ask` rules
  // or by a hook", and this field is set only where neither forced it.
  return modePrompt === true
}

/** Inputs of {@link permissionRememberScope}. */
export interface PermissionRememberScopeInputs {
  type?: PermissionRequestType['type']
  /** `ComposerCapabilities.connection.activeRuntime` — the runtime this session is on right now. */
  activeRuntime?: ComposerCapabilities['connection']['activeRuntime']
  /** F1.1236 — the PRODUCER's own statement of where its Always Allow is saved (`PermissionRequest.alwaysAllowScope`). */
  alwaysAllowScope?: PermissionRequestType['alwaysAllowScope']
}

/**
 * What "Always Allow" on THIS card actually buys — the sentence under the
 * buttons, and it is TWO different things, the second of which depends on the
 * RUNTIME rather than only on the request type.
 *
 * permissions.md's tier table: a Bash approval is remembered "Permanently per
 * repository and command" — it is written to `.claude/settings.local.json` at
 * the repository root — while a file-modification approval lasts "Until session
 * end". The tip said "for the session" for both, which was true of neither: the
 * store was a ten-minute window.
 *
 * A worktree setup script is the durable one on EVERY runtime, and stays so:
 * that consent record is the host's own per-script, per-project file
 * (`packages/server-core/src/sessions/SessionManager.ts` symbol
 * `persistBashAlwaysAllowRule`'s neighbour `worktreeSetupConsent`), written the
 * same way whichever runtime is in the session.
 *
 * ## C3.365 — one sentence, two behaviours
 *
 * Measured on the packaged 1.36.0, both arms with both controls green: on claude
 * the branch asks AGAIN with the same `["Bash(touch *)"]` already on disk (R6a,
 * RS-36), and on Pi the same grant TRAVELS the branch, from the same file in the
 * same build (R7, RS-36 PASS). One card, two scopes.
 *
 * The CAUSE, read rather than inferred, and it is what decides the wording. A
 * `.claude/settings.local.json` `permissions.allow` block is compiled into the
 * readable permission DSL (`packages/shared/src/agent/permissions-config.ts`
 * symbol `claudeSettingsPermissionDsl`) and an `allow` match there CLEARS an ask
 * — but only where that DSL is evaluated. `evaluatePermissionDslV1` scores 2
 * occurrences in `pi-agent.ts` and 2 in `codex-agent.ts` against 1 in
 * `claude-agent.ts` that sits INSIDE a comment (`grep -ac`, i.e. matching LINES,
 * 2026-09-13), so the claude arm never evaluates it: what runs there is our own
 * `runPreToolUseChecks` as a PreToolUse hook, which fires for every tool call
 * whatever the SDK's own rules say. What an Always Allow leaves behind on claude
 * is therefore the SESSION whitelist alone
 * (`packages/shared/src/agent/core/permission-manager.ts` symbol
 * `whitelistCommand`, *"for the remainder of the session"*), and a branch is a
 * new session.
 *
 * So the honest sentence is `repository` on Pi and codex and `session` on
 * claude — and since F1.128 the card no longer spells that table: the Bash arm
 * asks `bashAlwaysAllowRememberScope` (`agent/core/bash-remember-scope.ts`), the
 * compiler-total table the WRITE reads (D1.436), so the sentence and the write
 * cannot disagree and a new runtime breaks the build in that one place.
 *
 * `origin` cannot answer this and must not be used for it: a claude Bash card
 * raised by our gate carries `origin: 'host_gate'`, exactly like Pi's, and
 * `packages/shared/src/agent/claude-agent.ts` says so at the card site — the
 * host gate wearing claude's clothes, with `claude_native` reserved for
 * `askToolApproval`, where the SDK itself asks.
 *
 * POSTURE, and the row is a `[product]` one so it is stated rather than taken
 * quietly: where the two answers disagree the card takes the WEAKER promise.
 * Under-promising costs a user one extra click; over-promising teaches them that
 * the dialog lies. It is also why an unknown or unrepresented runtime lands on
 * `session` — and why the repository rule the host still writes on claude is not
 * mentioned: it is real, the claude child's own rules can honour it, and it
 * decides nothing about whether this product asks again.
 *
 * ## F1.1236 — a producer that saves the grant elsewhere says so
 *
 * Codex's command card carries no `type`, so it fell to `session` while its
 * Always Allow had saved a rule in the WORKSPACE `permissions.json` since
 * F1.1057 (codex's execpolicy grant) — and a new session then ran the command
 * with no card (final sitting SIT2-d). Only the producer knows whether this press
 * will be saved (`codex-agent.ts` symbol `codexAlwaysAllowScope` applies the
 * write's own tests), so its statement outranks every arm below; absent, the
 * card answers as before.
 *
 * Exported and pure because the four arms are four ways the sentence can be
 * wrong, and markup can only show which one was rendered.
 */
export function permissionRememberScope({
  type,
  activeRuntime,
  alwaysAllowScope,
}: PermissionRememberScopeInputs): 'repository' | 'session' | 'workspace' {
  if (alwaysAllowScope === 'workspace') return 'workspace'
  if (type === 'worktree_setup') return 'repository'
  if (type !== 'bash') return 'session'
  return bashAlwaysAllowRememberScope(activeRuntime)
}

/**
 * D1.284 — the card and the host now read ONE list.
 *
 * This file used to carry a COPY of the host's `DANGEROUS_COMMANDS`, pinned by
 * a test that read `permission-manager.ts` as source text and asserted set
 * equality, because the host's list was a module-private `const` behind a class
 * the renderer cannot construct. The list and its two predicates moved to
 * `packages/shared/src/agent/core/dangerous-commands.ts` — a leaf module with
 * no imports, so nothing of the permission engine's graph comes with it — and
 * the copy, its set and the source-text pin are gone.
 */

/** Inputs of {@link alwaysAllowIsSessionOnly}. */
export interface AlwaysAllowSessionOnlyInputs {
  type?: PermissionRequestType['type']
  /** The command the card is showing — `PermissionRequest.command`. */
  command?: string
}

/**
 * D1.262 — does this card's Always Allow buy anything beyond the session?
 *
 * ## What was measured, and it is why the button is relabelled rather than hidden
 *
 * RS-54 pressed Always Allow on `curl -s https://example.invalid/` on
 * `claude-gateway` in `default`; the card cleared and no rule was written —
 * correctly, because `SessionManager.persistBashAlwaysAllowRule` returns early
 * for a base command on the dangerous list (`touch` in the same case wrote
 * `Bash(touch *)`, the control). The refusal is not claude's: `pi-agent.ts`
 * refuses the same rule with `updated_permissions_refused` (*"never
 * session-whitelisted"*) and `buildPermissionRequestSuggestions` does not even
 * offer the option for one.
 *
 * So the button offered a permanence the product had already decided never to
 * grant. It is RELABELLED and not removed because the answer still ALLOWS the
 * call, and on `curl`/`wget` it also whitelists the DOMAIN for the session
 * (`claude-agent.ts`'s own branch, taken ahead of the dangerous test).
 *
 * ## The sentence takes the WEAKER promise, which is this file's standing rule
 *
 * For every dangerous name but those two, nothing at all is remembered — the
 * session whitelist declines them as well — so the copy says the approval
 * cannot OUTLIVE the session rather than that it lasts for one. Under-promising
 * costs a user a click; over-promising teaches them the dialog lies, which is
 * the whole of this row.
 *
 * Both of the host's spellings are checked, for `persistBashAlwaysAllowRule`'s
 * own reason: `sudo apt install x` has base command `apt` and literal head
 * `sudo`, and a grant keyed on the first would outlive the session off a
 * privileged answer. An unparseable command is treated as session-only too —
 * the host refuses that case as well.
 *
 * D1.285 CLOSED THE HOST DEFECT THIS PARAGRAPH USED TO RECORD, and the copy
 * moved with it rather than after it. The four two-word names (`git push` and
 * its siblings) used to match nowhere — every caller looked up a one-word base
 * command, so `git push origin main` answered `false` on both spellings and the
 * host wrote `Bash(git *)` for it. The host now tests the WHOLE command line,
 * and for a base that HEADS a two-word entry it narrows the durable rule to the
 * exact approved line since UA12.84 (`Bash(git status)`) or refuses when the
 * second token cannot narrow it (`git -C /repo push`, bare `git`). All three arms are
 * mirrored below, because a card that said `false` where the host now refuses
 * would be the over-promise this row exists to end.
 *
 * WHAT THIS CANNOT SEE, stated so nobody reads `false` as a promise: the host
 * also declines to persist when the session is not bound to a directory, and
 * when the settings write itself is refused. `false` therefore means "not
 * refused for THIS reason", and the sentence it selects is the existing
 * per-runtime one, which is unchanged.
 */
export function alwaysAllowIsSessionOnly({ type, command }: AlwaysAllowSessionOnlyInputs): boolean {
  if (type !== 'bash') return false
  const trimmed = (command ?? '').trim()
  if (!trimmed) return true
  const tokens = trimmed.split(/\s+/)
  const literalHead = tokens[0] ?? ''
  const baseCommand = trimmed.match(/^(?:sudo\s+)?(\S+)/)?.[1] ?? literalHead
  if (!baseCommand) return true
  if (isDangerousCommandLine(trimmed)
    || isDangerousCommandLine(baseCommand)
    || isDangerousCommandLine(literalHead)) return true
  // D1.403 — a head that RUNS ITS OWN ARGUMENT buys nothing durable either.
  // Until this row the card showed the repository hint for `bash -c "rm -rf
  // dist"` and the host obliged, writing `Bash(bash *)` — a rule matching
  // `bash -c '<any script at all>'` in that repository for ever. The host now
  // mints no key for the family, so the card must not promise one; the sentence
  // it selects is the existing session-only one, which under-promises by this
  // file's standing rule rather than inventing new copy.
  if (headNamesCommandInterpreter(trimmed) || headNamesCommandInterpreter(baseCommand)) return true
  // D1.285 — the host writes a NARROWER rule for a base that heads a two-word
  // entry, and writes nothing at all when the second token cannot narrow it. An
  // approval of `git status` still buys a repository rule (since UA12.84 the
  // exact line, `Bash(git status)`), so this stays `false` for it;
  // `git -C /repo push` and a bare `git` buy nothing, so it does not.
  if (headsDangerousCommandPair(baseCommand)) {
    const subcommand = tokens[1] ?? ''
    if (!subcommand || subcommand.startsWith('-')) return true
  }
  // UA12.84 follow-up — the host's last two refusals, asked of the SAME two
  // functions `persistBashAlwaysAllowRule` calls rather than re-spelled here: no
  // key narrows the line (`NODE_ENV=production npm test`), or the rule text would
  // hold a `*` the DSL reads as a wildcard (`git log -- '*.ts'`, whose leading-
  // words key now persists as the exact line). Either way nothing durable is
  // written, so the card must not promise a repository rule.
  const key = bashSessionWhitelistKey(trimmed, baseCommand)
  return key === null || bashAlwaysAllowRuleContent(trimmed, key) === null
}

/**
 * UA12.105 — is this session-only grant the QUOTED-`*` case: the host stores the
 * line's session key ({@link bashSessionWhitelistKey}) but no rule text can say
 * the line ({@link bashAlwaysAllowRuleContent} is null for a `*` the rule grammar
 * would read as a wildcard), so the answer is remembered for the session and
 * nothing is saved for later. The card then says exactly that rather than the
 * dangerous-command sentence ("never saved for later"), which describes a line
 * whose answer the host keeps no key for at all (a curl/wget DOMAIN aside).
 */
export function alwaysAllowKeepsSessionKeyOnly({ type, command }: AlwaysAllowSessionOnlyInputs): boolean {
  if (type !== 'bash' || !alwaysAllowIsSessionOnly({ type, command })) return false
  const trimmed = (command ?? '').trim()
  const baseCommand = trimmed.match(/^(?:sudo\s+)?(\S+)/)?.[1] ?? ''
  const key = baseCommand ? bashSessionWhitelistKey(trimmed, baseCommand) : null
  return key !== null && bashAlwaysAllowRuleContent(trimmed, key) === null
}

/**
 * P6.951 + P6.864 — does THIS card offer a note on its answer?
 *
 * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt` gives the
 * two halves two deliveries, verbatim: *"**Yes**: Claude Code runs the action,
 * then sends your comment to Claude after the result. **No**: Claude Code sends
 * your comment to Claude as the reason for the denial, and Claude continues
 * working."* The No half is native on all three runtimes; the Yes half has no
 * channel on any of them, so the host queues it onto the next turn's user tail
 * (`BaseAgent.recordPermissionAnswerNote`). ONE field serves both, because the
 * page's own interaction is one field on whichever option you moved to, and the
 * button pressed is what names the half.
 *
 * FOUR cards are excluded, and each is a card whose "Deny" is not a refusal: the
 * outside-root grant, the worktree keep/remove pair, the reopen compact-or-keep
 * pair, and the first-outside-read three-answer card. Every one of them RENAMES
 * that button because the answer is a choice, and *"the reason for your denial"*
 * is the wrong question for all four. They are excluded on the Yes half too:
 * their Allow is a CHOICE with its own meaning, and a note beside it would be
 * annotating a different question than the one the card asked.
 *
 * The page's remaining carve-out holds where the answer is composed rather than
 * by a condition here — *"the options that allow the action for the rest of the
 * session or save a rule don't take one either"* — so Always Allow drops the
 * note (`permissionAnswerResponse`).
 *
 * A FIFTH exclusion is the RUNTIME's, and it is the reason this takes the
 * capabilities: on a runtime that carries neither half to the model the field
 * would ask the user to write a sentence to nobody. `capabilities.answerNote`
 * carries that verdict, resolved server-side beside the session-agent pin and
 * for the same reason.
 *
 * Exported because the five exclusions are five ways this must NOT appear, and a
 * markup test can only show that it does.
 */
export function answerNoteOffered(
  request: Pick<PermissionRequestType, 'type' | 'reopenCompact' | 'outsideWorkingDirectoryRead'>,
  capabilities: Pick<ComposerCapabilities, 'answerNote'>,
): boolean {
  return capabilities.answerNote === true
    && request.type !== 'outside_root'
    && request.type !== 'worktree_cleanup'
    && !request.reopenCompact
    && !request.outsideWorkingDirectoryRead
}

/**
 * P6.951 + P6.864 — either answer, with or without the note.
 *
 * `options` is ABSENT rather than an empty object when nothing was typed, so an
 * ordinary answer is byte-identical on the wire to one from before these rows —
 * and whitespace is not a note, because the field is offered on every ordinary
 * card and a stray space would otherwise become the whole reason the model is
 * given.
 *
 * `alwaysAllow` NEVER carries one, and that is the page's own carve-out rather
 * than a simplification: *"The options that allow the action for the rest of the
 * session or save a rule don't take one either."* A note explains one answer;
 * a rule outlives it.
 */
export function permissionAnswerResponse(
  answer: { allowed: boolean; alwaysAllow?: boolean },
  note: string,
): PermissionResponse {
  const comment = answer.alwaysAllow ? '' : note.trim()
  return {
    type: 'permission',
    allowed: answer.allowed,
    alwaysAllow: answer.alwaysAllow === true,
    ...(comment ? { options: { comment } } : {}),
  }
}

/**
 * PermissionRequest - Self-contained structured input for permission approval
 *
 * Decision-card anatomy (spec §7.6, UB14.24): hand icon tile + "Permission required" (or the
 * outside-read / outside-root title), the subagent that asked, the tool in mono and its description,
 * decision-model risk chips (destructive ring + tile when present), the artifact-publish details, the
 * impact block, the path or command in a sunken well (scrollable), then the answers — the affirmative
 * one primary, the wider "allow" ones secondary, the refusals ghost after the spacer — and the sentence
 * saying what an answer keeps in the quiet foot.
 */
export function PermissionRequest({
  request,
  onResponse,
  unstyled = false,
  permissionMode,
  onPermissionModeChange,
}: PermissionRequestProps) {
  const { t } = useTranslation()
  const capabilities = useComposerCapabilities()
  // UB6.10 — decision-model risk badges (opt-in, informational). Literal keys keep
  // the i18n coverage check effective; risks a newer server may send that this
  // client has no label for are left out (older clients stay safe).
  const riskLabels: Record<PermissionRisk, string> = {
    deletes: t('chat.permissionRisk.deletes'),
    sends: t('chat.permissionRisk.sends'),
    publishes: t('chat.permissionRisk.publishes'),
    credentials: t('chat.permissionRisk.credentials'),
    system: t('chat.permissionRisk.system'),
    spends: t('chat.permissionRisk.spends'),
  }
  const risks = knownPermissionRisks(request)
  // P6.208 (A40). The switch is only offered when the composer can actually
  // perform it, so a card mounted without a mode setter never grows a button
  // whose click would do half of what its label promises.
  const offersAutoModeSwitch = onPermissionModeChange !== undefined
    && shouldOfferAutoModeSwitch({
      type: request.type,
      origin: request.origin,
      modePrompt: request.modePrompt,
      permissionMode,
      availableModes: capabilities.permissions.modes,
    })
  // P6: outside-root approvals map Allow -> once (narrower default) and
  // Always Allow -> for this session. The server owns the canonical root and
  // receipt; the renderer only submits requestId + selected lifetime.
  const isOutsideRoot = request.type === 'outside_root'
  // P6.202 clause (3) — the FIRST read outside the working directories in auto
  // mode. Selected by the payload's presence rather than by a `type` member,
  // because the `PermissionRequestType` union is spelled out verbatim in six
  // files; the reason is recorded in full on the payload type itself.
  const outsideRead = request.outsideWorkingDirectoryRead
  // P6.500 — the reopen compact-or-keep card, selected by its payload for
  // `outsideRead`'s reason: the `PermissionRequestType` union is spelled out
  // verbatim in several files, the Swift client's among them, so a new member
  // costs a wire-drift sweep that a payload does not.
  //
  // The first two answers ride the two buttons the card already has, and they
  // are not Allow/Deny: "Deny" here is not a refusal, it is the user choosing to
  // keep the whole conversation and pay for it on every later request. So the
  // labels say what they do — the same reason the worktree card renames its
  // pair — and neither button gets the destructive tone, because neither
  // destroys anything the other keeps.
  //
  // P6.950 added the THIRD, `sessions.md#resume-from-a-summary`'s own:
  // *"**Don't ask me again**: resumes the full session and stops showing the
  // dialog on all future resumes."* It is the as-is answer plus `alwaysAllow`,
  // which `respondToPermission` reads as the host effect that turns the dialog
  // off — the shape `outsideWorkingDirectoryRead` uses for its own third
  // answer. The server still sends `noAlwaysAllow`, and that is not a
  // contradiction: it withholds the GENERIC *Always Allow*, whose label and
  // scope are the wrong question here, so a client that does not know this
  // payload still shows exactly two. This comment said "no third button can
  // appear beside them" until that row.
  const reopenCompact = request.reopenCompact
  // P6.135 — a keep-or-remove card, not an allow/deny one.
  //
  // `worktrees.md#clean-up-worktrees` frames the close-time question as
  // "keep or remove the worktree", and the generic Allow/Deny pair reads as the
  // wrong question for it: "Deny" is not a refusal, it is the SAFE half — the
  // directory and branch stay. So the two buttons say what they do, and the
  // destructive tone comes off the keep button, because keeping destroys
  // nothing, and removing is guarded host-side by the same release the model's
  // ExitWorktree goes through.
  const isWorktreeCleanup = request.type === 'worktree_cleanup'
  // UA1.18 — the `publish_artifact` card, selected by its payload for `outsideRead`'s reason. Its Allow is labelled
  // with what it does (Publish / Update); the host sends `noAlwaysAllow`, so no remembering answer is drawn.
  const artifactPublish = request.artifactPublish
  // Some approvals cover exactly one action and cannot be remembered (Monitor's
  // WebSocket source). Offering the button would promise something the server
  // refuses to honour, so it is not rendered at all.
  // A cleanup decision is about ONE worktree at ONE close and is never
  // remembered: an "always remove" would be a standing instruction to delete
  // directories, which is the posture P6.135 deliberately did not take.
  const canRemember = request.noAlwaysAllow !== true && !isWorktreeCleanup
  // C3.365 — what the sentence under the buttons may honestly promise, per
  // request type AND per runtime. The whole derivation, its two measurements and
  // the reason `origin` cannot answer it live on {@link permissionRememberScope}.
  const rememberScope = permissionRememberScope({
    type: request.type,
    activeRuntime: capabilities.connection.activeRuntime,
    alwaysAllowScope: request.alwaysAllowScope,
  })
  // D1.262 — a base command the product never remembers for later. It outranks
  // the per-runtime scope above, because the refusal is the host's and is the
  // same on all three runtimes; see {@link alwaysAllowIsSessionOnly}.
  const grantIsSessionOnly = alwaysAllowIsSessionOnly({ type: request.type, command: request.command })
  // F1.1219 — the Claude Agent SDK's `defaultToNo` hint (`agent-sdk/typescript.md#canusetool`):
  // *"a single stray keystroke must not approve this request: open your prompt on its decline
  // option, don't pre-select approve, and offer no one-key approve shortcut."* So the card opens
  // with focus on Deny (Enter or Space then declines) and Allow loses the solid primary (UB14.24: secondary).
  // This card binds no approve key, so the third clause holds already. The sibling
  // `suppressAlwaysAllowRule` arrives as `noAlwaysAllow` and is `canRemember` above.
  const opensOnDecline = request.defaultToNo === true
  // F1.1219 follow-up 2 — only the focused panel takes focus, the rule ChatDisplay's
  // textarea already follows: every open panel renders its own composer, so a card
  // raised in a panel the user is not in would pull the caret out of the one they
  // are typing in, and their next Space or Enter would decline an ask they never
  // saw. Such a card still meets the hint: Allow stays secondary and nothing
  // pre-selects approve. Outside the panel shell (playground) there is no context.
  const isFocusedPanel = useOptionalAppShellContext()?.isFocusedPanel ?? true
  const takesFocus = opensOnDecline && isFocusedPanel

  // P6.864 — Allow carries the note when one was typed; Always Allow never does
  // (the page's own carve-out, stated on `permissionAnswerResponse`). The note
  // state it reads is declared further down, beside the affordance that fills
  // it; that is legal and intended here because a handler body runs after
  // render, never during it.
  const handleAllow = () => {
    onResponse(permissionAnswerResponse({ allowed: true }, offersAnswerNote ? answerNote : ''))
  }

  const handleAlwaysAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: true })
  }

  /**
   * P6.951 — the note a DENIAL may carry.
   *
   * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`:
   * *"**No**: Claude Code sends your comment to Claude as the reason for the
   * denial, and Claude continues working."* On claude that reason is native —
   * `PermissionResult.deny.message`, which our code has always filled with a
   * constant.
   *
   * THREE carve-outs, and they are the page's own plus one this card owns:
   * - the Yes half is not offered, because it has no channel on any runtime (the
   *   SDK's allow branch carries no feedback field). It is a host injection and
   *   stays on P6.864.
   * - the remembering answers are not offered one: *"The options that allow the
   *   action for the rest of the session or save a rule don't take one either."*
   *   Nothing is wired to Always Allow, so this holds by construction.
   * - the cards whose "Deny" is not a refusal are excluded — the worktree
   *   keep/remove pair, the reopen compact-or-keep pair, the outside-root grant
   *   and the first-outside-read card each rename that button because the answer
   *   is a CHOICE, and "the reason for your denial" is the wrong question for all
   *   four.
   *
   * Not a textarea and not persisted: it is one sentence about one refusal, sent
   * once. The Tab-to-open interaction the page describes is a terminal
   * affordance; here the equivalent is a button that reveals the field, which is
   * the same two-step in a mouse-and-keyboard surface.
   */
  const offersAnswerNote = answerNoteOffered(request, capabilities)
  const [answerNoteOpen, setAnswerNoteOpen] = React.useState(false)
  const [answerNote, setAnswerNote] = React.useState('')

  const handleDeny = () => {
    onResponse(permissionAnswerResponse({ allowed: false }, offersAnswerNote ? answerNote : ''))
  }

  // "Select it to approve the command and switch the session to auto mode" —
  // both halves, in that order: the answer this card owes the waiting tool call
  // first, then the mode change. It is an approve-ONCE, not an always-allow:
  // the page's sentence grants this command and changes the mode, and nothing
  // in it writes a durable rule for the command as well.
  const handleAllowAndSwitchToAuto = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: false })
    onPermissionModeChange?.('auto')
  }

  // P6.202 clause (3) — auto mode's first read outside the working directories.
  // The three answers ride the two booleans the response already has; the
  // mapping is stated on `FirstOutsideReadPermissionRequest`
  // (`core/types/message.ts`) and executed by
  // `applyOutsideWorkingDirectoryReadAnswer` (`shared/agent/mode-manager.ts`),
  // so these three lines are the only place a renderer spells it.
  const handleKeepAllowingOutsideReads = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: false })
  }
  const handleBlockOutsideReadsFromNowOn = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: true })
  }
  const handleAskAboutOutsideReadsAgain = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: false })
  }

  // P6.950 — the reopen dialog's third answer: resume as-is (`allowed: false`,
  // the same half `handleDeny` sends) AND stop asking (`alwaysAllow`). The note
  // is deliberately not attached: it is an answer that saves a rule, and the
  // page's own carve-out says those take no comment.
  const handleReopenDontAskAgain = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: true })
  }

  // UB6.10 — a card with at least one known risk takes the danger tone (the
  // destructive ring and tile); presentation only, the outcome is unchanged.
  // Upstream's own line (`risks.length > 0 ? 'danger' : 'info'`), over the same
  // `knownPermissionRisks` source `getDecisionTone` reads for the composer ring,
  // so the card and the slot around it never disagree.
  const tone: DecisionTone = risks.length > 0 ? 'danger' : 'info'

  // UB14.24 — what the foot says an answer keeps. Every card variant keeps its
  // own sentence (the tip used to sit at the end of the actions row); the
  // repeat glyph is upstream's, drawn where the sentence is about remembering.
  const footSentence = outsideRead
    ? t('chat.outsideRead.hint')
    : isOutsideRoot
    ? t('chat.outsideRoot.hint')
    : reopenCompact
    ? t('chat.reopenCompact.hint')
    : isWorktreeCleanup
    ? t('worktree.cleanup.hint')
    : canRemember
      ? t(grantIsSessionOnly
          // UA12.105 — a quoted-`*` line keeps its session key and saves nothing for later.
          ? (alwaysAllowKeepsSessionKeyOnly({ type: request.type, command: request.command })
              ? 'chat.permissionRemember.quotedStar'
              : 'chat.permissionRemember.dangerous')
          : rememberScope === 'repository'
            ? 'chat.permissionRemember.repository'
            : rememberScope === 'workspace'
              ? 'chat.permissionRemember.workspace'
              : 'chat.permissionRemember.session')
      // UA12.105 — a Bash card with no Always Allow (the host minted no key) remembers nothing; "this one
      // connection" is the Monitor WebSocket card's sentence, which keeps it.
      : t(request.type === 'bash' ? 'chat.permissionRemember.bashOnce' : 'chat.permissionRemember.never')
  const footRemembers = outsideRead !== undefined || (canRemember && !reopenCompact && !isWorktreeCleanup)

  return (
    <DecisionCard tone={tone} standalone={!unstyled} data-tutorial="permission-banner">
      {/* Content - grows to fill available space and scrolls before actions disappear */}
      <DecisionBody>
        <DecisionHeader
          tone={tone}
          icon={tone === 'danger' ? <TriangleAlert /> : <Hand />}
          title={t(outsideRead
            ? 'chat.outsideRead.header'
            : isOutsideRoot ? 'chat.outsideRoot.header' : 'chat.permissionRequired')}
        />
        <DecisionDetails>
          {/* sub-agents.md:1043 — a subagent's prompt surfaces in the session
              the user is watching, not in its own hidden one. Without naming
              the agent, the user is asked to approve a command they never see
              being run and cannot attribute. First in the details, so it is
              read before the call it attributes. */}
          {request.agentLabel && (
            <div className="mb-2 flex w-fit max-w-full items-center gap-1.5 rounded-md bg-info-tint px-2 py-1 text-label-sm text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
              <Bot className="text-info" />
              <span className="min-w-0 truncate">
                <span className="font-medium">{t('chat.permissionFromAgent')}:</span> {request.agentLabel}
              </span>
            </div>
          )}
          <p className="text-label text-secondary">
            <span className="font-medium text-foreground">{t('chat.permissionTool')}:</span>{' '}
            <span className="font-mono text-mono-ui text-foreground">{request.toolName}</span>
            <br />
            {request.description}
          </p>
          {/* UB6.10 — the risk badges, v0.15.1's chip markup. A FIXED slot
              between the description and the call detail, so the buttons never
              reflow under the cursor, and informational only: they never change
              the prompt or its outcome. */}
          {risks.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1" title={t('chat.permissionRiskHint')}>
              {risks.map((risk) => (
                <span key={risk} className="inline-flex h-5 items-center rounded-full bg-destructive-tint px-2 text-label-sm font-medium text-destructive">
                  {riskLabels[risk]}
                </span>
              ))}
            </div>
          )}

          {artifactPublish && (
            <div className="mt-2.5">
              <ArtifactPublishDetails card={artifactPublish} />
            </div>
          )}

          {/* Impact — WHY this call is riskier than the description says.
              `impact` is set by the pre-tool-use pipeline for prompts that carry
              a consequence the description does not state; the live producer is
              the sandbox-escape band ("Runs outside the sandbox: matched the
              administrator's excludedCommands pattern …"). It was computed,
              wired and persisted but rendered only on the admin_approval card,
              so an ordinary Bash prompt asked a human to approve a command that
              leaves isolation without saying so.

              Deliberately NOT ordinary detail text next to the description: the
              whole point is that it outranks the description, so it keeps a
              toned block of its own (upstream's anatomy has no warning slot;
              this is ours, re-hosted in `DecisionDetails`), and it sits ABOVE
              the call detail — a long command scrolls inside its own well, and
              anything placed under it can be pushed out of view at the moment
              of the click.

              UB12.84 — the tone is v0.15.1's amber "needs you" role: the info
              tint with the info inset hairline (`Info_Alert` variant="info"'s
              material, on the sibling wells' rounded-md geometry) and the solved
              `text-info` ink. Until UB12.84 it spelled `border-warning/30
              bg-warning/10 text-warning`, but tokens.css defines no warning
              colour, so those classes generated no CSS and the block drew as
              untinted body text. `PermissionImpact.test.tsx` checks every colour
              class here against tokens.css' own names. */}
          {request.impact && (
            <div
              className="mt-2.5 flex items-start gap-1.5 rounded-md bg-info-tint px-2.5 py-2 text-label text-info inset-ring inset-ring-[var(--info-border)] [&_svg]:size-3.5 [&_svg]:shrink-0"
              data-testid="permission-impact"
            >
              <TriangleAlert className="mt-[2px]" />
              <span className="min-w-0">
                <span className="font-medium">{t('chat.permissionImpact')}:</span> {request.impact}
              </span>
            </div>
          )}

          {/* P6.202 clause (3) — the path IS the decision, so it gets the same
              sunken mono well a command does, with the directory it was
              measured against beneath it. The page's own question is "whether to
              keep allowing those reads", which nobody can answer without seeing
              which path fell outside and what it fell outside OF. */}
          {outsideRead && (
            <>
              <DecisionPreview>{outsideRead.path}</DecisionPreview>
              {outsideRead.workingDirectory && (
                <div className="mt-1 break-all text-label-sm text-tertiary">
                  {t('chat.outsideRead.workingDirectory')}: <span className="font-mono">{outsideRead.workingDirectory}</span>
                </div>
              )}
            </>
          )}

          {/* Command preview */}
          {request.command && (
            <DecisionPreview>{request.command}</DecisionPreview>
          )}
        </DecisionDetails>
      </DecisionBody>

      {/* P6.202 clause (3) — a THREE-answer row, and its own row rather than a
          relabeling of the two-answer one. The generic pair cannot express it:
          "Block from now on" is a refusal that WRITES a setting, and "Ask again
          next time" is a refusal that writes nothing, so the difference between
          the two Deny-shaped answers is the whole point of the card.

          Order follows the page's own list, and the safest answer is not first:
          "Keep allowing" is what the model is asking for and what the page puts
          first, "Block from now on" is the durable one, "Ask again next time"
          is the do-nothing answer that leaves the decision for later. On the
          anatomy the affirmative answer is the primary and both refusals are
          ghosts after the spacer — the page's order is unchanged. */}
      {outsideRead ? (
        <DecisionActions>
          <Button
            variant="primary"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleKeepAllowingOutsideReads}
            data-testid="outside-read-keep-allowing"
          >
            {t('chat.outsideRead.keepAllowing')}
          </Button>
          <DecisionSpacer />
          <Button
            variant="ghost"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleBlockOutsideReadsFromNowOn}
            data-testid="outside-read-block"
          >
            {t('chat.outsideRead.blockFromNowOn')}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleAskAboutOutsideReadsAgain}
            data-testid="outside-read-ask-again"
          >
            {t('chat.outsideRead.askAgain')}
          </Button>
        </DecisionActions>
      ) : (
      /* Action buttons */
      <DecisionActions>
        <Button
          // F1.1219 — a `defaultToNo` ask does not draw Allow as THE default
          // (the solid primary); see `opensOnDecline` above.
          variant={opensOnDecline ? 'secondary' : 'primary'}
          size="lg"
          className={DECISION_ACTION}
          onClick={handleAllow}
          data-tutorial="permission-allow-button"
        >
          {isOutsideRoot
            ? t('chat.outsideRoot.allowOnce')
            : artifactPublish
            ? (artifactPublish.mode === 'update' ? t('chat.artifactPublish.update') : artifactPublish.chatShare ? t('sessionMenu.share') : t('chat.artifactPublish.publish'))
            : reopenCompact
            ? t('chat.reopenCompact.summary')
            : isWorktreeCleanup ? t('worktree.cleanup.remove') : t('chat.permissionAllow')}
        </Button>
        {/* P6.208 (A40) — the documented third answer, between "approve this
            one" and "remember this one", because that is what it is: a wider
            approval than Allow that is not a rule about this command. A
            secondary, like the other answers wider than Allow. */}
        {offersAutoModeSwitch && (
          <Button
            variant="secondary"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleAllowAndSwitchToAuto}
            data-testid="permission-switch-to-auto"
          >
            {t('chat.permissionSwitchToAuto')}
          </Button>
        )}
        {canRemember && (
          <Button
            variant="secondary"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleAlwaysAllow}
          >
            {isOutsideRoot
              ? t('chat.outsideRoot.allowSession')
              : grantIsSessionOnly
                // D1.262 — the label says what the answer buys. The button still
                // sends `alwaysAllow`, which is what whitelists a curl/wget
                // DOMAIN for the session; what it never buys is the repository
                // rule the old label promised.
                ? t('chat.permissionAlwaysAllow.sessionOnly')
                : t('chat.permissionAlwaysAllow')}
          </Button>
        )}
        <DecisionSpacer />
        {/* The refusal is upstream's ghost. On the worktree and reopen cards it
            is the KEEP half — keeping destroys nothing and the as-is reopen
            costs tokens but loses nothing — so the ghost is the right weight
            there too; the dashed destructive treatment it replaced is gone. */}
        <Button
          variant="ghost"
          size="lg"
          className={DECISION_ACTION}
          onClick={handleDeny}
          autoFocus={takesFocus}
          data-testid="permission-deny"
        >
          {reopenCompact
            ? t('chat.reopenCompact.asIs')
            : isWorktreeCleanup ? t('worktree.cleanup.keep') : t('chat.permissionDeny')}
        </Button>
        {/* The page's third answer, LAST because that is where the page puts it
            and because it is the widest: the other two decide this reopen, this
            one decides every future reopen as well. The same ghost as the as-is
            answer beside it — it destroys nothing either. */}
        {reopenCompact && (
          <Button
            variant="ghost"
            size="lg"
            className={DECISION_ACTION}
            onClick={handleReopenDontAskAgain}
            data-testid="reopen-compact-dont-ask"
          >
            {t('chat.reopenCompact.dontAsk')}
          </Button>
        )}
        {offersAnswerNote && !answerNoteOpen && (
          <Button
            variant="ghost"
            size="lg"
            className={DECISION_ACTION}
            onClick={() => setAnswerNoteOpen(true)}
            data-testid="permission-answer-note-open"
          >
            <MessageSquarePlus />
            {t('chat.permissionComment.add')}
          </Button>
        )}
        {offersAnswerNote && answerNoteOpen && (
          <Input
            type="text"
            autoFocus
            value={answerNote}
            onChange={event => setAnswerNote(event.target.value)}
            // P6.864 — no Enter binding, deliberately. It denied while the field
            // could only mean a refusal; now the same note can ride EITHER
            // answer, and no key press names which one. A user who typed
            // guidance and pressed Enter would have refused the call they meant
            // to permit — the one failure this field must not have. The two
            // buttons are the submit, and both are one Tab away.
            placeholder={t('chat.permissionComment.placeholder')}
            aria-label={t('chat.permissionComment.add')}
            // Its own full-width line under the answers: the note belongs to
            // whichever answer is pressed, so it sits beside none of them.
            className="basis-full"
            data-testid="permission-answer-note"
          />
        )}
      </DecisionActions>
      )}

      {/* What an answer keeps — upstream's foot, carrying OUR per-variant sentence. */}
      <DecisionFoot icon={footRemembers ? <RefreshCw /> : undefined}>{footSentence}</DecisionFoot>
    </DecisionCard>
  )
}
