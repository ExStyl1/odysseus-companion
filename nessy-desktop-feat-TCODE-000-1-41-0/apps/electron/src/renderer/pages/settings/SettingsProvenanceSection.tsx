/**
 * P6.168 — "where settings come from", the read-only checkup.
 *
 * No surface on any runtime named which file supplied an effective setting, and
 * the runtime we vendor does not answer it either: `settings.md` says of its own
 * startup line, verbatim, *"The line confirms which files Claude Code read; it
 * doesn't show which file supplied each key."* The two narrow exceptions do not
 * close it — `claude doctor` lists REJECTED entries only, and the header names a
 * file only for a model — and `SDKSystemMessage` carries no such field. So the
 * host answers it once and every runtime shows the same text, because it reads
 * the host's own merge rather than three runtimes' reports.
 *
 * ## Two shapes here are the finding, not the styling
 *
 * **Per FAMILY, never per key.** There is no whole-settings merge in this host
 * to hang per-key provenance on: four readers each take their own narrow slice
 * of `.claude/settings.json`, with their own scope orders, and they never meet.
 * A per-key table would be a fictional fifth resolver.
 *
 * **Two stacks for a Claude session, not one.** We pass the child
 * `settingSources: ['user','project','local']` and cannot read back what it made
 * of them. Folding those files into the list above would claim a merge nobody
 * performs; the second section says whose stack it is and that we cannot see
 * into it.
 *
 * Read-only by construction (owner decision D12, 2026-09-05) — nothing here is
 * a control, and there is no setter on the channel it reads.
 *
 * P6.169 (wave 6, W6-m) mounts codex's arm beside these: codex publishes a
 * per-key origin map through `config/read` with `includeLayers`, which is a
 * THIRD shape again — per key, from the runtime — so it lands as its own section
 * rather than being merged into the host families.
 *
 * ## UB15.8 — on v0.15.1's settings material
 *
 * The card is v0.15.1's raised `SettingsCard`, and each group — the intro sentences, one block per family, the
 * connection pane, codex's layers, Claude Code's own stack — is one padded block (`settingsUI.cardPadding`) split
 * from the next by the card's own hairline instead of a hand-drawn `border-t`. Headings take the row label
 * (`settingsUI.label`), explanations the row description (`settingsUI.description`), paths the mono UI type, and
 * the muted shadcn ink becomes the solved role inks: what supplies the answer stays on the foreground, context on
 * `text-secondary`, a file that does not answer on `text-tertiary`. `SettingsProvenanceView` is the section as it
 * draws for one answer, so the playground sweeps every state the read can reach; the default export only loads.
 * Nothing it shows or reads changed.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'
import type {
  CodexConfigLayerEntryV1,
  CodexConfigProvenanceV1,
  SettingsProvenanceEntryV1,
  SettingsProvenanceFamilyIdV1,
  SettingsProvenanceReportV1,
} from '@nessy-agent/shared/config/config-doctor'
import type { ConnectionCredentialSourceV1, ConnectionProvenanceV1 } from '@nessy-agent/shared/protocol'

/**
 * P6.447 — the credential MECHANISM, one sentence each.
 *
 * The wire carries a value and the surface owns the wording, for the same
 * reason every other reason-code in this product does: a sentence built on the
 * server cannot be translated, and a sentence built twice diverges.
 */
/** One group of the card: the in-card padding, its lines stacked (UB15.8). */
const BLOCK_CLASS = cn(settingsUI.cardPadding, 'space-y-1')
/** A list of label · value lines inside a block (scope · file · state, key · layer · file). */
const LINE_LIST_CLASS = 'space-y-0.5 pt-0.5'
/** One label · value line: wraps as a whole, small label type. */
const LINE_CLASS = 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-label-sm'
/** A path or a value read verbatim: mono UI type, broken anywhere only when it must. */
const MONO_CLASS = 'font-mono text-mono-ui [overflow-wrap:anywhere]'

const CREDENTIAL_LABEL_KEY: Readonly<Record<ConnectionCredentialSourceV1, string>> = {
  'stored-api-key': 'settings.provenance.connectionCredentialStoredKey',
  'stored-oauth': 'settings.provenance.connectionCredentialStoredOauth',
  'stored-token': 'settings.provenance.connectionCredentialStoredToken',
  environment: 'settings.provenance.connectionCredentialEnvironment',
  'platform-credentials': 'settings.provenance.connectionCredentialPlatform',
  none: 'settings.provenance.connectionCredentialNone',
}

/**
 * P6.447 — the connection pane, INSIDE this view rather than as a competing page.
 *
 * Claude's `/status` is inside the closed binary and unreachable from an
 * SDK-hosted session; codex publishes no equivalent; Pi is ours. So this is the
 * host answering once, which is what makes the four facts read identically on
 * all three runtimes instead of being three separately-derived reports.
 *
 * The gateway/BYO line is the row's own requirement and is deliberately the
 * loudest thing here: the verified gateway is the ONE endpoint whose requests
 * this product rewrites and to which it attaches a `Nestor-Token`, and a user
 * who cannot tell the two apart cannot reason about where their key is going.
 */
export function ConnectionPane({ connection }: { connection: ConnectionProvenanceV1 }) {
  const { t } = useTranslation()
  const rows: [string, string][] = [
    ['settings.provenance.connectionProvider', connection.providerLabel],
    [
      'settings.provenance.connectionBaseUrl',
      connection.baseUrl ?? t('settings.provenance.connectionBaseUrlDefault'),
    ],
    [
      'settings.provenance.connectionCredential',
      t(CREDENTIAL_LABEL_KEY[connection.credentialSource]),
    ],
    [
      'settings.provenance.connectionProxy',
      connection.proxy
        ? `${connection.proxy.name} = ${connection.proxy.value}`
        : t('settings.provenance.connectionProxyNone'),
    ],
  ]

  return (
    <div className={BLOCK_CLASS} data-testid="settings-connection-pane">
      <div className={settingsUI.label}>{t('settings.provenance.connectionTitle')}</div>
      <p className={settingsUI.description}>{t('settings.provenance.connectionScopeNote')}</p>
      {connection.connectionSlug === null
        ? (
          <p className={cn(settingsUI.description, 'pt-0.5')}>
            {t('settings.provenance.connectionNone')}
          </p>
        )
        : (
          <>
            <p
              className={cn(
                'pt-0.5 text-label-sm',
                connection.verifiedGateway ? 'font-medium text-foreground' : 'text-secondary',
              )}
              data-testid={connection.verifiedGateway ? 'connection-gateway' : 'connection-byo'}
            >
              {t(connection.verifiedGateway
                ? 'settings.provenance.connectionGateway'
                : 'settings.provenance.connectionByo')}
            </p>
            <div className={LINE_LIST_CLASS}>
              {rows.map(([labelKey, value]) => (
                <div key={labelKey} className={LINE_CLASS}>
                  <span className="text-secondary">{t(labelKey)}</span>
                  <span className={cn(MONO_CLASS, 'text-foreground')}>{value}</span>
                </div>
              ))}
            </div>
          </>
        )}
    </div>
  )
}

const FAMILY_LABEL_KEY: Readonly<Record<SettingsProvenanceFamilyIdV1, string>> = {
  permissions: 'settings.provenance.familyPermissions',
  instructionExcludes: 'settings.provenance.familyInstructionExcludes',
  skillOverrides: 'settings.provenance.familySkillOverrides',
  managedSettings: 'settings.provenance.familyManagedSettings',
}

const SCOPE_LABEL_KEY: Readonly<Record<SettingsProvenanceEntryV1['scope'], string>> = {
  managed: 'settings.provenance.scopeManaged',
  user: 'settings.provenance.scopeUser',
  project: 'settings.provenance.scopeProject',
  local: 'settings.provenance.scopeLocal',
}

const STATE_LABEL_KEY: Readonly<Record<SettingsProvenanceEntryV1['state'], string>> = {
  supplies: 'settings.provenance.stateSupplies',
  'present-no-keys': 'settings.provenance.statePresentNoKeys',
  missing: 'settings.provenance.stateMissing',
}

const COMBINE_LABEL_KEY = {
  'last-wins': 'settings.provenance.combineLastWins',
  union: 'settings.provenance.combineUnion',
  'winner-takes-all': 'settings.provenance.combineWinnerTakesAll',
} as const

function EntryRow({ entry }: { entry: SettingsProvenanceEntryV1 }) {
  const { t } = useTranslation()
  // A file that supplies the family is the answer to the question; the other two
  // states are context, and are muted so the answer is findable at a glance.
  const supplies = entry.state === 'supplies'
  return (
    <div className={LINE_CLASS}>
      <span className={supplies ? 'font-medium text-foreground' : 'text-secondary'}>
        {t(SCOPE_LABEL_KEY[entry.scope])}
      </span>
      <span className={cn(MONO_CLASS, supplies ? 'text-foreground' : 'text-tertiary')}>
        {entry.file}
      </span>
      <span className="text-tertiary">{t(STATE_LABEL_KEY[entry.state])}</span>
    </div>
  )
}

/**
 * One `t(…, { count })` call serves all three, and only ONE of them is a plural
 * family — deliberate, and worth a sentence because the locale files no longer
 * show it (P6.976).
 *
 * `supplies` has `_one`/`_other` in en and `_one`/`_few`/`_many`/`_other` in ru
 * and **no unsuffixed key**: i18next appends the suffix at call time, so the
 * base named here is the only thing a reader can name. It carried the bare key
 * too until 2026-09-10 — the only family of 69 in either locale that did, and
 * the shape that let `check-i18n-parity.ts`'s `enKeys.has(base)` escape excuse a
 * half-built English family (P6.973). Measured against i18next 26.3.1 before it
 * was dropped: `count` 0/1/2/5/21 in both locales returns byte-identical
 * strings with and without it, because every plural category either language
 * needs is present as a suffixed key.
 *
 * The other two are single strings and stay that way. They are passed the same
 * `count` and resolve through i18next's own fallback to the unsuffixed key —
 * the positive control that the fallback works, so a state that later becomes
 * count-driven only needs its suffixed keys added.
 */
const CODEX_STATE_LABEL_KEY: Readonly<Record<CodexConfigLayerEntryV1['state'], string>> = {
  supplies: 'settings.provenance.codexStateSupplies',
  'present-no-keys': 'settings.provenance.codexStatePresentNoKeys',
  'not-applied': 'settings.provenance.codexStateNotApplied',
}

/**
 * P6.169 — the codex runtime's own answer, in its own section.
 *
 * NOT merged into the family list above, and the reason is the shape rather
 * than the styling: the families are per-family attributions of one host file,
 * and this is per KEY from a different runtime's own stack. Folding them
 * together would claim a merge nobody performs — the same reason Claude Code's
 * child stack is a second list rather than a fifth family.
 *
 * Three things are rendered that a naive list would drop, each measured on the
 * shipped binary (2026-09-08) rather than assumed:
 *
 * - `not-applied` is its own state, styled as the one to act on. A project
 *   layer that is READ, carries keys, and is refused because the project is not
 *   trusted came back with exactly that shape, and the runtime's own
 *   `disabledReason` names the remedy, so it is shown verbatim.
 * - The defaults sentence. `origins` explained 2 keys of 97 in force, so a list
 *   without it reads as "these are all my settings".
 * - `label` is optional, because `sessionFlags` is a layer with no file. The
 *   surface says "not a file" rather than rendering an empty path.
 */
function CodexPane({ codex }: { codex: CodexConfigProvenanceV1 }) {
  const { t } = useTranslation()
  return (
    <div className={BLOCK_CLASS} data-testid="provenance-codex">
      <div className={settingsUI.label}>{t('settings.provenance.codexTitle')}</div>
      <p className={settingsUI.description}>{t('settings.provenance.codexDesc')}</p>
      <div className={LINE_LIST_CLASS}>
        {codex.layers.map(layer => {
          const supplies = layer.state === 'supplies'
          const notApplied = layer.state === 'not-applied'
          return (
            <div key={`${layer.kind}:${layer.label ?? ''}`} className="space-y-0.5">
              <div className={LINE_CLASS}>
                <span className={supplies ? 'font-medium text-foreground' : 'text-secondary'}>
                  {layer.kind}
                </span>
                <span className={cn(MONO_CLASS, supplies ? 'text-foreground' : 'text-tertiary')}>
                  {layer.label ?? t('settings.provenance.codexNoFile')}
                </span>
                <span className={notApplied ? 'font-medium text-foreground' : 'text-tertiary'}>
                  {t(CODEX_STATE_LABEL_KEY[layer.state], { count: layer.keys.length })}
                </span>
              </div>
              {layer.disabledReason !== undefined && (
                <p className={cn(settingsUI.description, 'pl-2 [overflow-wrap:anywhere]')}>{layer.disabledReason}</p>
              )}
            </div>
          )
        })}
      </div>
      <p className={cn(settingsUI.description, 'pt-1')}>
        {t('settings.provenance.codexDefaultsNote', {
          explained: codex.origins.length,
          total: codex.effectiveKeyCount,
        })}
      </p>
      {codex.origins.length > 0 && (
        <>
          <div className={cn(settingsUI.label, 'pt-1')}>
            {t('settings.provenance.codexOriginsTitle')}
          </div>
          <div className={LINE_LIST_CLASS}>
            {codex.origins.map(origin => (
              <div key={origin.key} className={LINE_CLASS}>
                <span className={cn(MONO_CLASS, 'text-foreground')}>{origin.key}</span>
                <span className="text-secondary">{origin.kind}</span>
                <span className={cn(MONO_CLASS, 'text-tertiary')}>
                  {origin.label ?? t('settings.provenance.codexNoFile')}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** What the section has read: the host's report (with the P6.447 connection riding it), or nothing yet. */
export type SettingsProvenanceAnswer = (SettingsProvenanceReportV1 & { connection?: ConnectionProvenanceV1 }) | null

/**
 * UB15.8 — the section as it draws for one answer: `report` null and `failed` false is the first paint before the
 * read answers, `failed` the checkup that could not run. The default export below is this plus the read.
 */
export function SettingsProvenanceView({ report, failed }: { report: SettingsProvenanceAnswer; failed: boolean }) {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={t('settings.provenance.title')}
      description={`${t('settings.provenance.description')} ${t('settings.provenance.scopeNote')}`}
    >
      <SettingsCard>
        <div className={BLOCK_CLASS}>
          <p className={settingsUI.description}>{t('settings.provenance.perFamilyNote')}</p>

          {failed && (
            <p className={settingsUI.description}>{t('settings.provenance.unavailable')}</p>
          )}

          {report?.projectDirectory === undefined && !failed && (
            <p className={settingsUI.description}>{t('settings.provenance.projectAbsent')}</p>
          )}
        </div>

        {report?.families.map(family => (
          <div key={family.id} className={BLOCK_CLASS}>
            <div className={settingsUI.label}>{t(FAMILY_LABEL_KEY[family.id])}</div>
            <p className={settingsUI.description}>{t(COMBINE_LABEL_KEY[family.combine])}</p>
            <div className={LINE_LIST_CLASS}>
              {family.entries.map(entry => (
                <EntryRow key={`${family.id}:${entry.scope}:${entry.file}`} entry={entry} />
              ))}
            </div>
          </div>
        ))}

        {report?.connection && <ConnectionPane connection={report.connection} />}

        {report?.codex && <CodexPane codex={report.codex} />}

        {report && report.claudeChildSettingSources.length > 0 && (
          <div className={BLOCK_CLASS}>
            <div className={settingsUI.label}>{t('settings.provenance.claudeChildTitle')}</div>
            <p className={settingsUI.description}>{t('settings.provenance.claudeChildDesc')}</p>
            <div className={LINE_LIST_CLASS}>
              {report.claudeChildSettingSources.map(entry => (
                <EntryRow key={`claude:${entry.scope}:${entry.file}`} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

export default function SettingsProvenanceSection({ workspaceId }: { workspaceId?: string }) {
  // P6.447 rides the SAME channel: it is the same question one layer out
  // (where did the effective answer come from), and the row's own sequencing
  // rule is that it must not open a competing page.
  const [report, setReport] = useState<SettingsProvenanceAnswer>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      setReport(await window.electronAPI.getSettingsProvenance(workspaceId))
      setFailed(false)
    } catch {
      // A checkup that cannot run says so. It never repairs and never guesses:
      // an invented answer here is indistinguishable from a real one, which is
      // the whole failure this view exists to remove.
      setReport(null)
      setFailed(true)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  return <SettingsProvenanceView report={report} failed={failed} />
}
