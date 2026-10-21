import { CapabilityMaterializationError } from '@nessy-agent/shared/capabilities/materializer';
import { expect, test } from 'bun:test'
import { WorkspaceEventBus } from '@nessy-agent/shared/automations'
import type { CapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import type { RuntimeMonitorRegistration } from '@nessy-agent/shared/capabilities/resolver'
import { PluginMonitorService } from './plugin-monitor-service.ts'

const monitor: RuntimeMonitorRegistration = {
  key: 'plugin://market/monitor#hash@workspace:ws',
  monitorId: 'remind',
  resource: { pluginInstanceId: 'plugin://market/monitor@1.0.0#hash', relativePath: 'monitors/remind.md', contentHash: 'hash' },
  cron: '* * * * *',
  executableHash: 'hash',
  pluginInstanceId: 'plugin://market/monitor@1.0.0#hash',
}

test('delivers a pinned monitor only from SchedulerTick and disarms on dispose', async () => {
  const eventBus = new WorkspaceEventBus('ws')
  const calls: string[] = []
  const materializer: CapabilitySnapshotMaterializer = {
    assertActive: () => calls.push('active'),
    verifyPlugin: async id => { calls.push(`verify:${id}`) },
    resolvePath: async () => '/unused',
    readText: async () => { calls.push('read'); return 'monitor context' },
    resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
  }
  const delivered: Array<{ text: string; generation: string }> = []
  const service = new PluginMonitorService({
    eventBus,
    monitor,
    materializer,
    generation: 'generation-1',
    deliver: async input => { delivered.push(input); return true },
  })

  service.start()
  await eventBus.emit('SchedulerTick', { workspaceId: 'ws', timestamp: Date.now(), localTime: '', utcTime: '' })

  expect(delivered).toEqual([{ text: 'monitor context', generation: 'generation-1' }])
  expect(calls).toEqual(expect.arrayContaining(['active', `verify:${monitor.pluginInstanceId}`, 'read']))

  service.dispose()
  await eventBus.emit('SchedulerTick', { workspaceId: 'ws', timestamp: Date.now(), localTime: '', utcTime: '' })
  expect(delivered).toHaveLength(1)
  eventBus.dispose()
})
