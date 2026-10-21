/**
 * F1.424 — the guard for the teardown tracker twenty plugin-store suites now
 * depend on. A tracker that let a promise through would put those suites back
 * in the lottery without a sound: their teardown would simply stop waiting.
 */
import { describe, expect, it } from 'bun:test'
import { createInstallTracker } from '../install-tracker.ts'

class FakeService {
  #copied: string[] = []
  finished = 0
  readonly label = 'fake'

  async install(name: string, ms: number): Promise<string> {
    await Bun.sleep(ms)
    this.#copied.push(name)
    this.finished += 1
    return name
  }

  async fail(ms: number): Promise<never> {
    await Bun.sleep(ms)
    throw new Error('install refused')
  }

  copied(): string[] {
    return [...this.#copied]
  }
}

describe('createInstallTracker (F1.424)', () => {
  it('settle waits for an install the case never awaited — the teardown race', async () => {
    const installs = createInstallTracker()
    const service = installs.track(new FakeService())
    void service.install('bundle', 40)
    // The control: without settle, a teardown running now would find the copy
    // still in flight — exactly the state `afterEach` used to delete a root in.
    expect(service.finished).toBe(0)
    expect(installs.pending).toBe(1)
    await installs.settle()
    expect(service.finished).toBe(1)
    expect(installs.pending).toBe(0)
  })

  it('hands the caller the same value and the same rejection, and settle never throws', async () => {
    const installs = createInstallTracker()
    const service = installs.track(new FakeService())
    expect(await service.install('bundle', 1)).toBe('bundle')
    const refused = service.fail(1)
    await expect(refused).rejects.toThrow('install refused')
    await installs.settle()
    expect(installs.pending).toBe(0)
  })

  it('runs every method on the real object: private fields, sync results and plain properties pass through', async () => {
    const installs = createInstallTracker()
    const service = installs.track(new FakeService())
    await service.install('a', 1)
    expect(service.copied()).toEqual(['a'])
    expect(service.label).toBe('fake')
    expect(installs.pending).toBe(0)
  })

  it('settle also waits for a tracked call started by a call it was already waiting for', async () => {
    const installs = createInstallTracker()
    const raw = new FakeService()
    const service = installs.track(raw)
    // The repair-after-install shape: the second call starts only once the
    // first has settled, i.e. after `settle` began waiting. One `allSettled`
    // would return with the repair still copying; the loop must not.
    void service.install('first', 20).then(() => service.install('repair', 20))
    await installs.settle()
    expect(raw.copied()).toEqual(['first', 'repair'])
  })
})
