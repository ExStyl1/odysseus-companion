import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'
import { parityUiComponents } from '../registry/parity-ui'

function variantNames(id: string): string[] {
  return parityUiComponents.find(component => component.id === id)
    ?.variants?.map(variant => variant.name) ?? []
}

describe('parity UI playground registry', () => {
  it('registers the canonical Plan-3 parity playground entries', () => {
    expect(parityUiComponents.map(component => component.id)).toEqual([
      'parity-permission-mode-selector',
      'parity-terminal-verdict-row',
      'parity-agent-elapsed',
      'parity-todo-list-card',
      'parity-memory-viewer',
      'parity-checkpoint-revert-action',
      'parity-context-overlay-suggestions',
      'parity-compact-model-selector',
      'parity-desktop-model-picker',
      'parity-dark-theme-sweep',
    ])

    const indexSource = readFileSync(
      new URL('../registry/index.ts', import.meta.url),
      'utf8'
    )
    expect(indexSource).toContain("import { parityUiComponents } from './parity-ui'")
    expect(indexSource).toContain('...parityUiComponents')
  })

  it('covers every permission mode in parity and legacy badge entries', () => {
    // Variant names are the mode IDS (registry chrome is structure, not text);
    // the rendered words come from the same i18n mode.* keys the composer reads.
    //
    // TWO sets since R15, and the second is not decoration: on `codex-runtime`
    // every row carries the note saying what that runtime can enforce of the
    // mode, which makes those rows the TALLEST the dropdown ever renders. The
    // playground exists to sweep layout states, so the state that sets the
    // dropdown's height has to be one of them.
    expect(variantNames('parity-permission-mode-selector')).toEqual([
      ...PERMISSION_MODE_ORDER,
      ...PERMISSION_MODE_ORDER.map(mode => `${mode} on codex`),
      // UB14.29 — the chip's lock, its icon-only folds, and the open desktop menu (rows + note + cycle footer).
      'Locked (Manual)',
      'Narrow panels (icon only)',
      'Menu open on codex',
    ])

    const chatSource = readFileSync(
      new URL('../registry/chat.tsx', import.meta.url),
      'utf8'
    )
    expect(chatSource).toContain('options: PERMISSION_MODE_ORDER.map')
    expect(chatSource).toContain('...PERMISSION_MODE_ORDER.map')
  })

  it('keeps a dedicated playground state for each new Plan-3 UI surface', () => {
    // P2.37 — one variant per reason that HAS verdict copy, plus the state
    // that renders nothing. The silent arm is the one worth a variant: it is
    // invisible in the app by construction, so the playground is the only
    // place a reviewer can see that a reason without copy leaks no enum value.
    //
    // `max_budget_tokens` joined in `409ca7a91` (P6.645), the host-side token
    // budget every runtime can honour because every runtime reports tokens. It
    // sits beside the money cap rather than replacing it: the two stop a turn
    // for different reasons and the row says which.
    expect(variantNames('parity-terminal-verdict-row')).toEqual([
      'max_agent_turns',
      'max_budget_usd',
      'max_budget_tokens',
      'structured_output_retry_exhausted',
      'provider_refusal',
      'provider_error (is_error)',
      'user_stop — no row',
    ])
    expect(variantNames('parity-agent-elapsed')).toEqual(['Subagent and workflow'])
    expect(variantNames('parity-todo-list-card')).toEqual(['Mixed state'])
    expect(variantNames('parity-memory-viewer')).toEqual(['MEMORY.md'])
    expect(variantNames('parity-checkpoint-revert-action')).toEqual(['Menu open'])
    expect(variantNames('parity-dark-theme-sweep')).toEqual(['Token sweep'])
    // S2 — the /context overlay is a design surface, so every state the
    // suggestion group can reach is a variant: none, one per rule, all three,
    // and all three under the documented over-limit warning.
    expect(variantNames('parity-context-overlay-suggestions')).toEqual([
      'No suggestions',
      'MCP tools',
      'Memory files',
      'Skills',
      'All three',
      'All three, over limit',
      // P6.599 — the not-loaded group is the same surface's other half: the
      // loaded-file list's negative space. Two variants, because the two
      // instruction-layer diagnostics can arrive together.
      'Ancestor layer cap',
      'Both not-loaded notices',
    ])
    // P6.600 — the composer's model control had no harness at all, so none of
    // the states `derivePickerMode` can reach had ever been on a screen a
    // reviewer could open. One variant per reachable state, not per prop.
    expect(variantNames('parity-compact-model-selector')).toEqual([
      'Trigger, several models',
      'Open, several models',
      'Empty model list',
      'One model',
      'Translated wire marked',
      'Connection unavailable',
      'Turn in flight',
      'Not switchable',
      // UB14.30 — v0.15.1's Cpu fold, the integration row with a second runtime, and the runtime's own levels.
      'Narrow panel (Cpu glyph)',
      'Two runtimes',
      'Codex effort levels (off–high)',
      'No effort levels',
    ])
    // UB14.30 — the desktop entry is the real `ComposerModelMenu` (chip + menu): the same seven states plus the chip
    // at rest, the integration list open on two runtimes, and the capability-driven effort levels.
    expect(variantNames('parity-desktop-model-picker')).toEqual([
      'Several models',
      'Empty model list',
      'One model',
      'Translated wire marked — RS-44 and DA2.25 in one view',
      'Connection unavailable',
      'Turn in flight',
      'Not switchable',
      'Trigger only (menu closed)',
      'Two runtimes, integration open',
      'Codex effort levels (off–high)',
      'No effort levels — no pill, no sub-menu',
    ])
  })

  /**
   * D1.214 — the two model pickers, harnessed on the SAME states.
   *
   * The desktop picker had no entry at all until this row: it was 270 lines of
   * JSX inside `FreeFormInput`, which is the whole composer. The two rows that
   * cost the most this week were both "the two pickers disagree" —
   * RS-44/DA2.23 (at 1400 px BOTH disclosure lines absent while the compact
   * picker showed both at 700 px, same card, same minute) and DA2.25 (the
   * per-row translated mark and the note under the list).
   *
   * So the assertion is the AGREEMENT rather than the presence: identical state
   * values on both entries, from the same fixtures. Two entries that each had
   * four states of their own could differ in exactly the way the two rows
   * describe and this case would pass.
   */
  it('gives the desktop picker the compact selector\'s own four states', () => {
    const states = (id: string): string[] => {
      const knob = parityUiComponents.find(component => component.id === id)
        ?.props?.find(prop => prop.name === 'state')
      const control = knob?.control as { options?: { value: string }[] } | undefined
      return (control?.options ?? []).map(option => option.value)
    }
    const compact = states('parity-compact-model-selector')
    // The probe found a real knob rather than an empty list, which is what makes
    // the equality below an assertion rather than `[] === []`.
    expect(compact).toEqual(['empty', 'single', 'flat', 'translated'])
    expect(states('parity-desktop-model-picker')).toEqual(compact)
  })

  it('renders BOTH disclosure lines and the per-row mark in the desktop menu', () => {
    // The two regressions, read where they landed. Source text and not a
    // render: this menu is a radix portal inside a dropdown and the question is
    // which children it composes, not how they lay out — and the layout is what
    // the playground entry above is for.
    const menu = readFileSync(
      new URL('../../components/app-shell/input/ComposerModelMenu.tsx', import.meta.url),
      'utf8'
    )
    // RS-44 / DA2.23 — the provenance line and the tool-egress disclosure, from
    // the SAME component the compact picker renders rather than a second copy.
    expect(menu).toContain('<ModelListDisclosures')
    expect(menu).toContain('variant="menu"')
    // DA2.25 — the per-row mark, which cannot move into that component because
    // it belongs inside each model button.
    expect(menu).toContain('data-testid="model-translated-mark"')
    expect(menu).toContain('isTranslatedWireSessionModel(')
    // The composer no longer renders any of it itself, so there is exactly ONE
    // desktop menu and a fix cannot land in a copy nobody reaches.
    const composer = readFileSync(
      new URL('../../components/app-shell/input/FreeFormInput.tsx', import.meta.url),
      'utf8'
    )
    expect(composer).toContain('<ComposerModelMenu')
    expect(composer).not.toContain('<ModelListDisclosures')
    expect(composer).not.toContain('data-testid="model-translated-mark"')
  })
})
