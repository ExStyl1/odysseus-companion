import { matchesCron, type EventBus } from '@nessy-agent/shared/automations'
import type { CapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import type { RuntimeScheduledMonitorRegistration } from '@nessy-agent/shared/capabilities/resolver'

/**
 * Delivers one trusted monitor resource into an already-running session. It
 * deliberately owns no schedule, session, queue, or durable state.
 *
 * SCHEDULED monitors only — the native `nessy-plugin.json` cron form. Claude's
 * `experimental.monitors` command form is a persistent background process and is
 * armed through `SessionMonitorService`, the same owner the `Monitor` tool uses
 * (`plugins/components.md#monitors`: "Plugin monitors use the same mechanism as the
 * Monitor tool").
 *
 * F1.502 — a tick with no running turn to take it is SKIPPED, not queued, and
 * that is the design rather than a gap: `deliver` answers `false` and nothing here
 * retries or holds the text. The resource is read and its plugin verified through
 * the TURN's capability materializer, and a capability generation is turn-pinned
 * (`armPluginPeripherals` disarms this service when the turn that armed it ends,
 * so between turns it is not subscribed at all); a queue would carry one
 * generation's text into a later turn whose generation may no longer hold the
 * plugin. `plugins/components.md#monitors` documents no scheduled form — its
 * monitor is the command form above, whose lines do queue and wake. The skip is
 * stated where the user meets the monitor: `/tasks` lists every scheduled monitor
 * the latest turn armed, from {@link monitor}, with that sentence beside it.
 */
export class PluginMonitorService {
  private disposed = false
  private subscribed = false

  /** F1.502 — the registration this service delivers, read by `/tasks`' listing. */
  get monitor(): RuntimeScheduledMonitorRegistration {
    return this.options.monitor
  }

  private readonly onTick = async (): Promise<void> => {
    if (this.disposed) return
    const { monitor, materializer, deliver, generation } = this.options
    if (!matchesCron(monitor.cron, monitor.timezone)) return
    materializer.assertActive()
    await materializer.verifyPlugin(monitor.pluginInstanceId)
    const text = await materializer.readText(monitor.resource)
    materializer.assertActive()
    await deliver({ text, generation })
  }

  constructor(private readonly options: {
    eventBus: Pick<EventBus, 'on' | 'off'>
    monitor: RuntimeScheduledMonitorRegistration
    materializer: CapabilitySnapshotMaterializer
    generation: string
    deliver(input: { text: string; generation: string }): Promise<boolean> | boolean
  }) {}

  start(): void {
    if (this.disposed) throw new Error('plugin-monitor-service-disposed')
    if (this.subscribed) return
    this.options.eventBus.on('SchedulerTick', this.onTick)
    this.subscribed = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (!this.subscribed) return
    this.options.eventBus.off('SchedulerTick', this.onTick)
    this.subscribed = false
  }
}
