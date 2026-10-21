import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeSessionCreateFailure } from '../NavigationContext'

/**
 * A failed `createSession` has to reach the user. It did not: the owner's
 * workspace pinned a default project folder that no longer resolved, every
 * `createSession` threw `workspace-default-project-invalid`, and the New Chat
 * button answered with nothing at all. Diagnosing it took a CDP probe.
 *
 * These pin the two halves that make the button honest again — the named code
 * gets plain language pointing at the setting to change, and anything else
 * still surfaces instead of vanishing.
 */

/** Mirrors i18next closely enough for these assertions: key in, English out. */
const en = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../../../packages/shared/src/i18n/locales/en.json'),
    'utf-8',
  ),
) as Record<string, string>
const t = (key: string): string => en[key] ?? key

describe('describeSessionCreateFailure', () => {
  it('explains the unusable default project folder in plain language', () => {
    const { title, description } = describeSessionCreateFailure(
      new Error('workspace-default-project-invalid'),
      t,
    )

    expect(title).toBe(en['toast.couldNotOpenChat']!)
    // Never the wire code — that string is what made the owner reach for CDP.
    expect(description).not.toContain('workspace-default-project-invalid')
    expect(description).toBe(en['toast.couldNotOpenChatDefaultFolder']!)
    // Actionable means naming where the setting lives, not just what broke.
    expect(description).toContain('Settings')
  })

  it('still surfaces an unnamed failure, carrying what it said', () => {
    const { title, description } = describeSessionCreateFailure(
      new Error('Workspace ws-7 not found'),
      t,
    )

    expect(title).toBe(en['toast.couldNotOpenChat']!)
    expect(description).toBe('Workspace ws-7 not found')
  })

  it('P6.133 — names the worktree refusal and keeps the host sentence underneath', () => {
    const { title, description } = describeSessionCreateFailure(
      new Error("session-worktree-failed: fatal: 'nessy-s1' is already checked out"),
      t,
    )

    // The NAMED half: a user who asked for isolation learns the session was
    // discarded, which no git sentence says.
    expect(title).toBe(en['worktree.newChat.failedTitle']!)
    expect(description).toContain(en['worktree.newChat.failedDesc']!)
    // The ACTIONABLE half is kept verbatim — it names which condition refused.
    expect(description).toContain("fatal: 'nessy-s1' is already checked out")
    // Never the wire prefix: that string is the one that sent the owner to CDP
    // the last time this file had to be written.
    expect(description).not.toContain('session-worktree-failed')
  })

  it('P6.133 — a bare refusal with no reason still says what happened', () => {
    const { description } = describeSessionCreateFailure(
      new Error('session-worktree-failed:'),
      t,
    )
    expect(description).toBe(en['worktree.newChat.failedDesc']!)
  })

  it('P6.133 NEGATIVE CONTROL: a git sentence with no prefix is still raw', () => {
    // Without this arm the match could have widened to any message mentioning a
    // worktree, and an unrelated failure would be reported as a discarded one.
    const { title, description } = describeSessionCreateFailure(
      new Error('fatal: not a git repository'),
      t,
    )
    expect(title).toBe(en['toast.couldNotOpenChat']!)
    expect(description).toBe('fatal: not a git repository')
  })

  it('has something to say about a throw that is not an Error and carries no message', () => {
    // The transport rebuilds a plain Error from the wire, but a renderer-side
    // throw need not be one, and an empty description would read as success.
    for (const thrown of [undefined, null, '', new Error('')]) {
      const { title, description } = describeSessionCreateFailure(thrown, t)
      expect(title).toBe(en['toast.couldNotOpenChat']!)
      expect(description).toBe(en['toast.unknownError']!)
    }
  })
})
