import { describe, expect, it } from 'bun:test'

import {
  FOREIGN_CLI_REMEDY_DETAIL,
  namesForeignCliRemedies,
  withForeignCliRemedyDetail,
} from '../gateway-model-refusal.ts'

/**
 * D1.118 — the detector reads the REMEDY, not the refusal.
 *
 * The positive is the gateway's own measured body (P6.1080, 2026-09-11,
 * verbatim); the negatives are the shapes that must NOT fire, and the third of
 * them is the one that decides whether this detector can be trusted at all: the
 * catalogue URL this repo names in a dozen comments ends in `/models`, and a
 * lazy substring test would annotate every error that mentions it.
 */
const GATEWAY_404 =
  'Модель tgpt/qwen35-397b-a17b-fp8 больше не поддерживается, выполните /auth и выберете доступную модель /model'

describe('namesForeignCliRemedies', () => {
  it('fires on the gateway refusal that prescribes nessy-cli commands', () => {
    expect(namesForeignCliRemedies(GATEWAY_404)).toBe(true)
    // Language-independent by construction: the same instruction in English.
    expect(namesForeignCliRemedies('Model retired. Run /auth, then pick a model with /model.')).toBe(true)
  })

  it('needs BOTH tokens, as commands, and is not fooled by a path or a plural', () => {
    // One token is not an instruction.
    expect(namesForeignCliRemedies('run /auth to sign in')).toBe(false)
    expect(namesForeignCliRemedies('choose with /model')).toBe(false)
    // A URL path is not a command — this is the catalogue endpoint and the
    // gateway's own auth path, both of which appear in ordinary diagnostics.
    expect(namesForeignCliRemedies('GET https://gateway.example/api/v1/cli/models and /api/v1/cli/auth failed')).toBe(false)
    // `/models` is not `/model`.
    expect(namesForeignCliRemedies('/auth failed while fetching /models')).toBe(false)
    // Nothing to read.
    expect(namesForeignCliRemedies(undefined)).toBe(false)
    expect(namesForeignCliRemedies(null)).toBe(false)
    expect(namesForeignCliRemedies('')).toBe(false)
  })
})

describe('withForeignCliRemedyDetail', () => {
  it('appends our sentence once, keeping whatever the runtime already said', () => {
    expect(withForeignCliRemedyDetail(['upstream line'], GATEWAY_404))
      .toEqual(['upstream line', FOREIGN_CLI_REMEDY_DETAIL])
    // A detail list that already carries it — a retry, a replayed transcript —
    // does not accumulate copies.
    expect(withForeignCliRemedyDetail(['upstream line', FOREIGN_CLI_REMEDY_DETAIL], GATEWAY_404))
      .toEqual(['upstream line', FOREIGN_CLI_REMEDY_DETAIL])
    expect(withForeignCliRemedyDetail(undefined, GATEWAY_404)).toEqual([FOREIGN_CLI_REMEDY_DETAIL])
  })

  it('returns the input UNCHANGED when nothing is owed, so a caller may apply it always', () => {
    const details = ['something else went wrong']
    expect(withForeignCliRemedyDetail(details, 'something else went wrong')).toBe(details)
    expect(withForeignCliRemedyDetail(undefined, 'something else went wrong')).toBeUndefined()
  })

  it('names both surfaces this product has, not only the ones it lacks', () => {
    // The sentence is the whole point of the row: "that command does not exist
    // here" without a replacement leaves the user exactly as stuck.
    expect(FOREIGN_CLI_REMEDY_DETAIL).toContain('connection card')
    expect(FOREIGN_CLI_REMEDY_DETAIL).toContain('model picker')
  })
})
