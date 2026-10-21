/**
 * UB14.28 — `SendButton`: v0.15.1's round accent control, over OUR four-state submit (codex wave 2.7).
 *
 * Instruments, both without a DOM (this repo ships none):
 * - `renderToStaticMarkup` for what the control draws (the file imports only barrel-free subpaths);
 * - the ELEMENT TREE the component returns, captured by calling it inside a probe component's render
 *   (its hooks run as the probe's), so the press handler it wires is a real function we can call —
 *   "does not call onStop" is asserted by pressing, not by reading source.
 *
 * Strings come from the shipped `en.json`, so a renamed or dropped key fails here too.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import {
  resolveSendButtonPress,
  SendButton,
  SendButtonTooltipBody,
  sendButtonState,
  type SendButtonProps,
} from '../SendButton'

const EN = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>
const KEYS = [
  'chat.submit.send', 'chat.submit.queue', 'chat.submit.steer', 'chat.submit.stop',
  'chat.processing.thinking', 'chat.midStream.overrideSteer', 'chat.midStream.overrideQueue',
] as const

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: Object.fromEntries(KEYS.map(key => [key, EN[key]])) } },
    interpolation: { escapeValue: false },
  })
})

function wrap(node: React.ReactNode): React.ReactElement {
  return (
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

const render = (node: React.ReactNode) => renderToStaticMarkup(wrap(node))

/** The element tree `SendButton` returns for these props (its hooks run inside the probe's render). */
function treeOf(props: SendButtonProps): React.ReactNode {
  let tree: React.ReactNode = null
  function Probe() {
    tree = SendButton(props)
    return null
  }
  renderToStaticMarkup(wrap(<Probe />))
  return tree
}

function findAll(node: React.ReactNode, match: (el: React.ReactElement<Record<string, unknown>>) => boolean, out: React.ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return out
  if (match(node)) out.push(node)
  findAll(node.props.children as React.ReactNode, match, out)
  return out
}

/** The one control element (`data-tutorial="send-button"`) in the tree. */
function controlOf(props: SendButtonProps) {
  const found = findAll(treeOf(props), el => el.props['data-tutorial'] === 'send-button')
  expect(found).toHaveLength(1)
  return found[0]!.props
}

const base = (overrides: Partial<SendButtonProps> = {}): SendButtonProps => ({
  mode: 'send',
  inert: false,
  disabled: false,
  onStop: () => {},
  ...overrides,
})

describe('UB14.28 · SendButton — the material is v0.15.1\'s, the states are ours', () => {
  it('the shipped keys exist (a missing one would render the bare key and still "pass")', () => {
    expect(KEYS.filter(key => typeof EN[key] !== 'string')).toEqual([])
  })

  it('POSITIVE — mode="steer" renders a SUBMIT named Steer, on the solid accent primary', () => {
    const markup = render(<SendButton {...base({ mode: 'steer' })} />)
    expect(markup).toContain('type="submit"')
    expect(markup).toContain(`aria-label="${EN['chat.submit.steer']}"`)
    expect(markup).toContain('data-mode="steer"')
    expect(markup).toContain('data-state="ready"')
    for (const cls of ['send-btn', 'rounded-full', 'bg-accent-solid', 'text-on-accent', 'size-control']) expect(markup).toContain(cls)
    expect(markup).toContain('data-variant="primary"')
    expect(markup).not.toContain('disabled=""')
    // The old grey disc is gone (upstream's "morphs instead of going grey").
    expect(markup).not.toContain('bg-foreground text-background')
  })

  it('POSITIVE — a live Stop is the SAME accent, a plain button, and its press stops the turn', () => {
    const markup = render(<SendButton {...base({ mode: 'stop' })} />)
    expect(markup).toContain('type="button"')
    expect(markup).toContain(`aria-label="${EN['chat.submit.stop']}"`)
    expect(markup).toContain('data-state="stop"')
    expect(markup).toContain('bg-accent-solid')
    expect(markup).not.toContain('disabled=""')

    const onStop = mock(() => {})
    const control = controlOf(base({ mode: 'stop', onStop }))
    expect(typeof control.onClick).toBe('function')
    ;(control.onClick as () => void)()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE (control) — mode="stop" + inert: a disabled plain button with NO handler, so a press cannot stop twice', () => {
    const onStop = mock(() => {})
    const markup = render(<SendButton {...base({ mode: 'stop', inert: true, disabled: true, onStop })} />)
    expect(markup).toContain('type="button"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('data-state="stop"')

    const control = controlOf(base({ mode: 'stop', inert: true, disabled: true, onStop }))
    expect(control.onClick).toBeUndefined()
    expect(control.type).toBe('button')
    expect(resolveSendButtonPress('stop', true, onStop)).toBeUndefined()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('boundary — Send/Queue/Steer never carry the stop handler; they submit the form', () => {
    const onStop = mock(() => {})
    for (const mode of ['send', 'queue', 'steer'] as const) {
      const control = controlOf(base({ mode, onStop }))
      expect({ mode, onClick: control.onClick, type: control.type }).toEqual({ mode, onClick: undefined, type: 'submit' })
    }
    expect(onStop).not.toHaveBeenCalled()
  })

  it('boundary — an empty Send is the primary\'s disabled fill (idle), not hidden', () => {
    const markup = render(<SendButton {...base({ disabled: true, blockReason: 'Nothing to send' })} />)
    expect(markup).toContain('data-state="idle"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('disabled:bg-fill-hover')
    expect(markup).toContain(`aria-label="${EN['chat.submit.send']}"`)
    expect(sendButtonState('send', false)).toBe('ready')
  })

  it('loading (a composer over a session the host does not own) and a running !cmd show the spinner', () => {
    const loading = render(<SendButton {...base({ mode: 'loading', inert: true, disabled: true })} />)
    expect(loading).toContain('type="button"')
    expect(loading).toContain(`aria-label="${EN['chat.processing.thinking']}"`)
    expect(loading).toContain('data-state="loading"')
    expect(loading).toContain('class="spinner')
    const busy = render(<SendButton {...base({ disabled: true, busy: true })} />)
    expect(busy).toContain('class="spinner')
    expect(render(<SendButton {...base()} />)).not.toContain('class="spinner')
  })

  it('every state keeps data-tutorial="send-button" (the CDP drivers find the Stop by it)', () => {
    for (const mode of ['send', 'queue', 'steer', 'stop', 'loading'] as const) {
      expect(render(<SendButton {...base({ mode })} />)).toContain('data-tutorial="send-button"')
    }
  })
})

describe('UB14.28 · the tooltip keeps our table (blocked reason, keys, P6.946/F1.331)', () => {
  it('Queue/Steer name Enter and Esc Esc on keycaps, and the override row by its effect', () => {
    const steer = render(<SendButtonTooltipBody mode="queue" disabled={false} midStreamOverride={{ hotkey: '⌥↵', behavior: 'steer' }} />)
    expect(steer).toContain(EN['chat.submit.queue'])
    expect(steer).toContain('>Enter</kbd>')
    expect(steer).toContain('>Esc Esc</kbd>')
    expect(steer).toContain('keycap')
    expect(steer).toContain(EN['chat.midStream.overrideSteer'])
    expect(steer).toContain('>⌥↵</kbd>')
    const queue = render(<SendButtonTooltipBody mode="steer" disabled={false} midStreamOverride={{ hotkey: '⌥↵', behavior: 'queue' }} />)
    expect(queue).toContain(EN['chat.submit.steer'])
    expect(queue).toContain(EN['chat.midStream.overrideQueue'])
    expect(queue).not.toContain(EN['chat.midStream.overrideSteer'])
  })

  it('NEGATIVE — with no override (unbound chord, staged files, an unsteerable row) the row is absent', () => {
    const markup = render(<SendButtonTooltipBody mode="steer" disabled={false} midStreamOverride={null} />)
    expect(markup).toContain('>Esc Esc</kbd>')
    expect(markup).not.toContain(EN['chat.midStream.overrideSteer'])
    expect(markup).not.toContain(EN['chat.midStream.overrideQueue'])
  })

  it('a disabled control says WHY; a plain Send or Stop says its own name', () => {
    expect(render(<SendButtonTooltipBody mode="send" disabled blockReason="Uploads pending" />)).toBe('Uploads pending')
    expect(render(<SendButtonTooltipBody mode="stop" disabled={false} />)).toBe(EN['chat.submit.stop']!)
    // The stop in flight is not "nothing to send": the caller passes no reason and the name stands.
    expect(render(<SendButtonTooltipBody mode="stop" disabled blockReason={null} />)).toBe(EN['chat.submit.stop']!)
  })
})
