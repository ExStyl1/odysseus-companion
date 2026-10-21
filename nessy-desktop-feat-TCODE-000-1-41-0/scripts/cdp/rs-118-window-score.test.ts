/**
 * RS-118 (F1.1289) - the 1M-window case's scorers, held against scripted readings, and the model ids it restates,
 * read back out of the registry so a rename there turns this file red instead of leaving the case asking a card for a
 * model the app no longer knows.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  carriesSelector, DISABLE_1M_ENV, expectedWindow, launchFromPsText, modelsFor, RS118_MODELS, windowOf,
} from './cases/rs-118.ts'

const PS_HEAD = '  PID   TT  STAT      TIME COMMAND\n 4242   ??  S      0:01.00 /Applications/Nessy Desktop.app/Contents/MacOS/Nessy Desktop '

describe('RS-118 - which launch the app was given', () => {
  it('reads the default launch, and the operator\'s variable when it is truthy', () => {
    expect(launchFromPsText([`${PS_HEAD}HOME=/Users/x NESSY_CONFIG_DIR=/tmp/rig`])).toBe('default')
    expect(launchFromPsText([`${PS_HEAD}NESSY_CONFIG_DIR=/tmp/rig ${DISABLE_1M_ENV}=1 HOME=/Users/x`])).toBe('disable-1m')
    expect(launchFromPsText([`${PS_HEAD}NESSY_CONFIG_DIR=/tmp/rig`, `${PS_HEAD}${DISABLE_1M_ENV}=true`])).toBe('disable-1m')
  })

  it('BOUNDARY - a falsy value, or the name inside another name, is the default launch', () => {
    expect(launchFromPsText([`${PS_HEAD}NESSY_CONFIG_DIR=/tmp/rig ${DISABLE_1M_ENV}=0`])).toBe('default')
    expect(launchFromPsText([`${PS_HEAD}NESSY_CONFIG_DIR=/tmp/rig X_${DISABLE_1M_ENV}=1`])).toBe('default')
  })

  it('CONTROL - a read without NESSY_CONFIG_DIR is unread, never the default', () => {
    expect(launchFromPsText([`${PS_HEAD}HOME=/Users/x`])).toBe('unread')
    expect(launchFromPsText([])).toBe('unread')
  })
})

describe('RS-118 - what each launch owes', () => {
  it('1M and both models by default; 200K and Opus 4.8 alone under the variable', () => {
    expect(expectedWindow('default')).toBe(1_000_000)
    expect(expectedWindow('disable-1m')).toBe(200_000)
    expect(modelsFor('default')).toEqual(['claude-opus-4-8', 'claude-fable-5-1'])
    expect(modelsFor('disable-1m')).toEqual(['claude-opus-4-8'])
  })

  it('takes the window only from a successful snapshot', () => {
    expect(windowOf({ success: true, usage: { contextWindow: 1_000_000 } })).toBe(1_000_000)
    expect(windowOf({ success: true, usage: { contextWindow: null } })).toBeUndefined()
    expect(windowOf({ success: false, usage: { contextWindow: 1_000_000 } })).toBeUndefined()
    expect(windowOf({ success: true, unsupported: true })).toBeUndefined()
    expect(windowOf(undefined)).toBeUndefined()
  })

  it('sees the [1m] selector in any case, and nothing else', () => {
    expect(carriesSelector('claude-opus-4-8[1m]')).toBe(true)
    expect(carriesSelector('"model":"claude-fable-5-1[1M]"')).toBe(true)
    expect(carriesSelector('claude-opus-4-8')).toBe(false)
    expect(carriesSelector('1m tokens')).toBe(false)
  })
})

describe('RS-118 - the restated model ids are the registry\'s', () => {
  it('each id the case drives is a model entry in packages/shared/src/config/models.ts', () => {
    const registry = readFileSync(join(import.meta.dir, '..', '..', 'packages', 'shared', 'src', 'config', 'models.ts'), 'utf8')
    for (const id of RS118_MODELS) expect(registry.includes(`id: '${id}',`)).toBe(true)
    // Control: the read can fail.
    expect(registry.includes("id: 'claude-opus-4-8-rs118-planted',")).toBe(false)
  })
})
