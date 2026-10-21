/**
 * P4.9 · the heartbeat elapsed must be VISIBLE on ordinary running tool rows,
 * and it must CHANGE when a new beat lands.
 *
 * The second half is the point. P0.7 already delivered `elapsedSeconds` into
 * renderer state for every beating tool and the value already updated on every
 * `task_progress` (`handlers/tool.ts` → `handleTaskProgress` finds the tool
 * message by `toolUseId` with no status filter). What was missing was the paint,
 * gated on the backgrounded branch. A test that only asserted "an elapsed
 * element is present" would pass against a row that renders once and then shows
 * a frozen number forever — which is the defect, not the fix. So the ticking is
 * asserted as a sequence of painted values.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { describeToolElapsed, type ToolElapsedLabels } from '../tool-elapsed'

/**
 * P2.494 · the three labels are now INJECTED, so the byte-identical pins below
 * need the English strings put back in. They are read from `en.json` rather
 * than retyped, which turns those pins into a real assertion again: a retyped
 * literal would keep passing after the key's value drifted, and the whole point
 * of the pins is that this text has never changed.
 */
const EN: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../../../../shared/src/i18n/locales/en.json', import.meta.url), 'utf8')
)

function interpolate(key: string, vars: Record<string, string>): string {
  const template = EN[key]
  if (template === undefined) throw new Error(`missing en.json key: ${key}`)
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '')
}

const labels: ToolElapsedLabels = {
  elapsed: duration => interpolate('turnCard.elapsed', { duration }),
  taskId: id => interpolate('turnCard.backgroundTaskId', { id }),
  shellId: id => interpolate('turnCard.backgroundShellId', { id }),
}

function running(elapsedSeconds?: number) {
  return { status: 'running', elapsedSeconds }
}

describe('describeToolElapsed (P4.9)', () => {
  it('paints the elapsed on an ordinary running tool', () => {
    const info = describeToolElapsed(running(30), labels)
    expect(info.kind).toBe('running-heartbeat')
    expect(info.text).toBe('30.0s elapsed')
  })

  it('paints a NEW value on every heartbeat — the row ticks, it does not freeze', () => {
    // One beat per 30s from the executor's re-armed timeout.
    const painted = [30, 60, 90, 120].map(s => describeToolElapsed(running(s), labels).text)
    expect(painted).toEqual(['30.0s elapsed', '1m 0s elapsed', '1m 30s elapsed', '2m+ elapsed'])
    // Every step differs from the one before: a frozen clock would collapse this.
    expect(new Set(painted).size).toBe(painted.length)
  })

  it('says nothing before the first beat lands', () => {
    // The executor's first beat is at 30s, so 0 means "no reading yet". Painting
    // "0.0s elapsed" would assert a measurement nobody took, and would put a
    // stopwatch on every tool that has barely started.
    expect(describeToolElapsed(running(0), labels)).toEqual({ kind: 'none', text: null })
    expect(describeToolElapsed(running(undefined), labels)).toEqual({ kind: 'none', text: null })
  })

  it('says nothing on a completed row carrying a stale beat', () => {
    // A completed tool keeps `elapsedSeconds` from its last beat; drawing it
    // would leave a frozen clock beside a finished row.
    expect(describeToolElapsed({ status: 'completed', elapsedSeconds: 90 }, labels).kind).toBe('none')
    expect(describeToolElapsed({ status: 'error', elapsedSeconds: 90 }, labels).kind).toBe('none')
    expect(describeToolElapsed({ status: 'pending', elapsedSeconds: 90 }, labels).kind).toBe('none')
  })

  it('refuses a nonsensical elapsed instead of painting it', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeToolElapsed(running(bad), labels).text).toBeNull()
    }
  })

  // ---- the pre-P4.9 behaviour, pinned so the widening cannot have changed it ----

  it('keeps the backgrounded task text byte-identical', () => {
    const info = describeToolElapsed({ status: 'backgrounded', taskId: 'agent_7', elapsedSeconds: 90 }, labels)
    expect(info.kind).toBe('backgrounded-task')
    expect(info.text).toBe('Task ID: agent_7, 1m 30s elapsed')
  })

  it('keeps the backgrounded shell text byte-identical', () => {
    const info = describeToolElapsed({ status: 'backgrounded', shellId: 'sh_3', elapsedSeconds: 30 }, labels)
    expect(info.kind).toBe('backgrounded-shell')
    expect(info.text).toBe('Shell ID: sh_3, 30.0s elapsed')
  })

  it('keeps a backgrounded row with no beat showing only its id', () => {
    expect(describeToolElapsed({ status: 'backgrounded', taskId: 'agent_7' }, labels).text).toBe('Task ID: agent_7')
  })

  it('still says nothing for a backgrounded row with neither id', () => {
    // Declining this case is deliberate and pre-existing: the id is what the
    // user needs in order to act on the row.
    expect(describeToolElapsed({ status: 'backgrounded', elapsedSeconds: 90 }, labels)).toEqual({ kind: 'none', text: null })
  })

  it('prefers the task id over a shell id when a row somehow carries both', () => {
    expect(describeToolElapsed({ status: 'backgrounded', taskId: 'a', shellId: 'b' }, labels).kind).toBe('backgrounded-task')
  })

  it('distinguishes the two kinds so the row can style them apart', () => {
    // A backgrounded id is actionable; a heartbeat is liveness only. The row
    // paints them differently and needs the kind to do it.
    expect(describeToolElapsed(running(30), labels).kind).not.toBe(
      describeToolElapsed({ status: 'backgrounded', taskId: 'a', elapsedSeconds: 30 }, labels).kind,
    )
  })
})
