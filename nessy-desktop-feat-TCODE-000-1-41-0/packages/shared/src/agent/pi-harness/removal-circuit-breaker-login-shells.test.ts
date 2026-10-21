/**
 * F1.99 (origin D1.417) — the seven `chsh`-able login shells D1.413's audit named
 * and left out of `SHELL_INTERPRETERS`: `nu`, `elvish`, `xonsh`, `ash`, `mksh`,
 * `yash`, `oksh`.
 *
 * Each runs its `-c` operand as a command line, and codex wraps EVERY command as
 * `<user shell> -lc '<script>'` (the transport `removal-circuit-breaker.test.ts`
 * records for `fish`), so on a machine whose login shell is one of these, every
 * codex command reached the removal floor by a spelling it could not read.
 *
 * Added on their DOCUMENTED `-c` semantics, not on a drive: none is installed on
 * this host, and the rig that could install and drive each one is an ASK, not a
 * claim. The direction is what makes that honest — a head wrongly called a shell
 * only offers MORE text to a scan that still demands `rm`/`rmdir`/`find` plus an
 * exact root-or-home target, so a wrong name can only ever ADD a refusal. The
 * does-not-fire block keeps that cheap: names that merely CONTAIN one of the
 * seven are pinned as NOT shells.
 */
import { describe, expect, test } from 'bun:test'

import { findRootOrHomeRemoval } from './removal-circuit-breaker.ts'

const HOME = '/Users/testuser'
const detect = (command: string) => findRootOrHomeRemoval(command, { home: HOME })

const SHELLS = ['nu', 'elvish', 'xonsh', 'ash', 'mksh', 'yash', 'oksh'] as const

describe('F1.99 — the seven login shells run their -c operand, so the floor reads it', () => {
  test.each(SHELLS.flatMap(shell => [
    [`${shell} -c 'rm -rf ~'`, 'home'],
    [`${shell} -lc 'rm -rf ~'`, 'home'],
    [`/usr/local/bin/${shell} -c 'rm -rf /'`, 'root'],
    [`sudo ${shell} -c 'rm -rf /'`, 'root'],
  ] as const))('%s', (command, target) => {
    expect(detect(command)?.target).toBe(target)
  })

  // Positive control on the same instrument: a shell already in the set fires,
  // so a red above is the NAME missing and not the probe.
  test('control: bash -c fires', () => {
    expect(detect(`bash -c 'rm -rf ~'`)?.target).toBe('home')
  })
})

describe('F1.99 — a name that merely CONTAINS one of the seven is not a shell', () => {
  test.each([
    `nuke -c 'rm -rf ~'`,
    `menu -c 'rm -rf ~'`,
    `trash -c 'rm -rf ~'`,
    `stash -c 'rm -rf ~'`,
    `flash -c 'rm -rf ~'`,
    `oksha -c 'rm -rf ~'`,
    `/opt/bin/myxonsh -c 'rm -rf ~'`,
    `elvisher -c 'rm -rf ~'`,
  ])('%s', command => {
    expect(detect(command)).toBeNull()
  })
})
