/**
 * P6.576 — the two settings-file tiers, on a surface inside the app.
 *
 * The record existed and only `/doctor` read it: a managed policy in effect, a
 * managed entry refused, a settings layer rejected whole, a policy file on disk
 * that is shadowed and enforces nothing — all of it discoverable exclusively by
 * running `nessy-general-agent doctor`, a CLI this app ships no route to. The
 * session-start line (W8-c's derivation, W7-v's emitting site) says THAT there
 * is something; this section is where the detail is read.
 *
 * ## The report is rendered as TEXT, deliberately
 *
 * `buildConfigDoctorReport` already renders every section, and it is the same
 * function the CLI calls, so the app and the terminal cannot describe one
 * machine differently. Decomposing it into React rows here would be a second
 * renderer for the same record — the exact shape that lets two surfaces drift —
 * and the report is written to be pasted into a ticket, which text preserves and
 * a table does not.
 *
 * ## It is missing ONE section, and it says which (P6.775)
 *
 * It used to be missing six, and the sentence here said so in general terms:
 * five of the doctor's collectors were "unexported functions inside
 * `apps/cli/src/doctor.ts`". P6.684 and P6.760 moved all seven into
 * `@nessy-agent/shared/config/doctor-collectors`; this docblock and the RPC's
 * kept asserting the old constraint for as long as nobody re-read them, and
 * `GET_CONFIG_DOCTOR` kept collecting to match — a page that reported less than
 * it could while telling the user the terminal reported more.
 *
 * The handler calls them now.
 *
 * ## It names the workspace it speaks for (P6.787)
 *
 * The one section still left out after P6.775 was project instruction files,
 * because that collector measures a DIRECTORY and this page named no workspace.
 * It named none because the channel took no argument — not because an app-level
 * page cannot have one — and `LIST_OUTPUT_STYLES` had been taking an optional
 * `workspaceId` in the same handler file all along.
 *
 * So this section asks about **the workspace this window has open**, and SAYS
 * SO: `workspaceNote` carries the workspace's name. A project-scoped section on
 * an app-level page that does not say which project is the same
 * silent-divergence shape the report exists to remove, and the sentence costs
 * one line. With no workspace open the section reports exactly what it did
 * before and `cliNote` — the one-section-missing sentence — is the true one.
 *
 * `useOptionalAppShellContext` rather than `useAppShellContext`: the playground
 * renders this component outside the shell, and a throwing hook there would
 * turn a design surface into a crash. Outside the shell there is no workspace,
 * which is exactly the no-workspace state above.
 *
 * Read-only by construction (owner decision D12): the channel has no setter and
 * this component never writes.
 *
 * ## C3.212 — and it SAYS so, because a refusal nobody can see is a defect
 *
 * `apps/cli/src/doctor.ts` has stated the invariant in its own docblock since
 * P6.398 — "Read-only by construction: this module reads files and writes to
 * stdout. It never repairs anything" — and the audience for that sentence is a
 * reader of this fork's source, not the operator holding a report of findings.
 * `description` said "read-only diagnosis", which an operator can fairly read as
 * "it has not written yet" rather than "it never will". `noRepairNote` closes
 * that: every finding is theirs to fix by hand, in the file the report names.
 * The same sentence belongs in `nessy-general-agent doctor`'s own help entry;
 * that half is handed to the lane holding `apps/cli/**` this wave.
 *
 * ## UB15.8 — on v0.15.1's settings material
 *
 * The card is v0.15.1's raised `SettingsCard` with two blocks split by its hairline: the answer (a state sentence
 * as a row description, then the report in the code well v0.15.1's technical details draw — `bg-sunken`, mono UI
 * type, `text-secondary` — keeping `whitespace-pre`, because the report's columns are its format and it is written
 * to be pasted), and the closing note as fine print. `ConfigDoctorView` is the section as it draws for one answer,
 * so the playground sweeps every state; the default export only reads the shell and loads. Nothing it shows or
 * reads changed.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import type { ConfigDoctorReportV1 } from '@nessy-agent/shared/config/config-doctor'

/** v0.15.1's code well (`Info_TechnicalDetails`), with the report's own `whitespace-pre` and height kept. */
const REPORT_WELL_CLASS =
  'max-h-96 overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-mono-ui whitespace-pre text-secondary select-text'

/**
 * UB15.8 — the section as it draws for one answer: `report` null and `failed` false is the first paint before the
 * read answers. `workspaceName` undefined is the no-workspace state, whose closing sentence still discloses the one
 * section the report cannot collect without a directory (P6.787).
 */
export function ConfigDoctorView({
  report,
  failed,
  workspaceName,
}: { report: ConfigDoctorReportV1 | null; failed: boolean; workspaceName: string | undefined }) {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={t('settings.configDoctor.title')}
      description={[
        t('settings.configDoctor.description'),
        t('settings.configDoctor.noRepairNote'),
        t('settings.configDoctor.scopeNote'),
      ].join(' ')}
    >
      <SettingsCard>
        {(failed || report) && (
          <div className={cn(settingsUI.cardPadding, 'space-y-2')}>
            {failed && (
              <p className={settingsUI.description}>{t('settings.configDoctor.unavailable')}</p>
            )}

            {report && !report.hasFindings && (
              <p className={settingsUI.description}>{t('settings.configDoctor.noFindings')}</p>
            )}

            {report && <pre className={REPORT_WELL_CLASS}>{report.text}</pre>}
          </div>
        )}

        <p className={cn(settingsUI.cardPadding, settingsUI.descriptionSmall)}>
          {workspaceName === undefined
            ? t('settings.configDoctor.cliNote')
            : t('settings.configDoctor.workspaceNote', { workspace: workspaceName })}
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}

export default function SettingsConfigDoctorSection() {
  const shell = useOptionalAppShellContext()
  const [report, setReport] = useState<ConfigDoctorReportV1 | null>(null)
  const [failed, setFailed] = useState(false)

  const activeWorkspaceId = shell?.activeWorkspaceId ?? null
  // The NAME, not the id, because the id is not what the user calls it. Absent
  // when the shell has an id it has no record for — then the report is still
  // workspace-scoped and the note falls back to the app-level sentence rather
  // than naming a workspace this component cannot name.
  const activeWorkspaceName = activeWorkspaceId === null
    ? undefined
    : shell?.workspaces.find(w => w.id === activeWorkspaceId)?.name

  const load = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      setReport(await window.electronAPI.getConfigDoctorReport(activeWorkspaceId ?? undefined))
      setFailed(false)
    } catch {
      // A diagnosis that cannot run says so. It never guesses and never
      // half-reports: an invented answer here is indistinguishable from a real
      // one, which is the whole failure this view exists to remove.
      setReport(null)
      setFailed(true)
    }
  }, [activeWorkspaceId])

  useEffect(() => { void load() }, [load])

  return <ConfigDoctorView report={report} failed={failed} workspaceName={activeWorkspaceName} />
}
