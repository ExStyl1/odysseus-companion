/**
 * P6.360 + P6.564 — the download setting, and the control that today's behaviour
 * is untouched without it.
 *
 * The resolver is pure and takes its environment as an argument, so no case
 * here assigns to `process.env` — which in Bun 1.3.14 leaves the name readable
 * by property and invisible to a spread, the trap every subprocess env in this
 * tree is built on.
 *
 * WHAT EACH TEST KILLS:
 *  - "unset changes nothing" dies if the resolver ever invents a root or turns
 *    the dialog on by itself, which is the whole of the row's control clause;
 *  - the two malformed cases die if a value that was SET is dropped in silence
 *    — an ignored setting nobody is told about is indistinguishable from a bug;
 *  - "a relative root is refused" dies if the root is passed through to
 *    `mkdirSync`, where it would resolve against the main process's cwd.
 */
import { describe, expect, it } from 'bun:test'
import {
  BROWSER_DOWNLOAD_ASK_ENV,
  BROWSER_DOWNLOAD_ROOT_ENV,
  describeBrowserDownloadSettings,
  resolveBrowserDownloadPolicy,
} from '../browser-download.ts'

describe('P6.360 — the browser download policy', () => {
  it('changes nothing when neither name is set', () => {
    for (const env of [{}, { [BROWSER_DOWNLOAD_ROOT_ENV]: '', [BROWSER_DOWNLOAD_ASK_ENV]: '   ' }]) {
      const policy = resolveBrowserDownloadPolicy(env)
      expect(policy.root).toBeUndefined()
      expect(policy.ask).toBe(false)
      expect(policy.problems).toEqual([])
    }
  })

  it('takes an absolute root', () => {
    const policy = resolveBrowserDownloadPolicy({ [BROWSER_DOWNLOAD_ROOT_ENV]: '  /tmp/nessy-dl  ' })
    expect(policy.root).toBe('/tmp/nessy-dl')
    expect(policy.ask).toBe(false)
    expect(policy.problems).toEqual([])
  })

  it('refuses a relative root and says which name it ignored', () => {
    const policy = resolveBrowserDownloadPolicy({ [BROWSER_DOWNLOAD_ROOT_ENV]: 'downloads' })
    expect(policy.root).toBeUndefined()
    expect(policy.problems).toHaveLength(1)
    expect(policy.problems[0]).toContain(BROWSER_DOWNLOAD_ROOT_ENV)
    expect(policy.problems[0]).toContain('not an absolute path')
  })

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['off', false],
  ])('reads the documented boolean %s', (value, expected) => {
    const policy = resolveBrowserDownloadPolicy({ [BROWSER_DOWNLOAD_ASK_ENV]: value as string })
    expect(policy.ask).toBe(expected as boolean)
    expect(policy.problems).toEqual([])
  })

  it('refuses a value that is not a boolean, and says so', () => {
    const policy = resolveBrowserDownloadPolicy({ [BROWSER_DOWNLOAD_ASK_ENV]: 'sometimes' })
    expect(policy.ask).toBe(false)
    expect(policy.problems).toHaveLength(1)
    expect(policy.problems[0]).toContain(BROWSER_DOWNLOAD_ASK_ENV)
  })

  it('carries both, so the dialog can start in the configured root', () => {
    const policy = resolveBrowserDownloadPolicy({
      [BROWSER_DOWNLOAD_ROOT_ENV]: '/tmp/nessy-dl',
      [BROWSER_DOWNLOAD_ASK_ENV]: 'on',
    })
    expect(policy.root).toBe('/tmp/nessy-dl')
    expect(policy.ask).toBe(true)
    expect(policy.problems).toEqual([])
  })
})

/**
 * P6.564 — the stored layer, and the ordering between it and the environment.
 *
 * WHAT EACH TEST KILLS:
 *  - "the file supplies both" dies if the stored block is declared but never
 *    read, which is the state P6.360 shipped and this row exists to end;
 *  - "the environment outranks the file" dies if the layers are merged in the
 *    other order, which would let a user setting escape an operator's constraint;
 *  - "a set-but-unusable variable still decides" dies if an operator's typo
 *    silently hands the choice back to the user;
 *  - "a relative stored root is refused BY NAME" dies if the sentence keeps
 *    naming the environment variable, which would send the reader to the wrong
 *    file;
 *  - the view's two `fromEnv` flags die if the settings form is left unable to
 *    say that what it saved is not what is in force.
 */
describe('P6.564 — the stored layer beside the environment', () => {
  it('takes the root and the switch from the file when the environment is silent', () => {
    const policy = resolveBrowserDownloadPolicy({}, { root: '/tmp/from-config', ask: true })
    expect(policy.root).toBe('/tmp/from-config')
    expect(policy.ask).toBe(true)
    expect(policy.rootLayer).toBe('config')
    expect(policy.askLayer).toBe('config')
    expect(policy.problems).toEqual([])
  })

  it('lets the environment outrank the file, in both directions', () => {
    const rootWins = resolveBrowserDownloadPolicy(
      { [BROWSER_DOWNLOAD_ROOT_ENV]: '/tmp/from-env' },
      { root: '/tmp/from-config', ask: false },
    )
    expect(rootWins.root).toBe('/tmp/from-env')
    expect(rootWins.rootLayer).toBe('env')

    // The interesting direction: an explicit `off` in the environment must be
    // able to turn a stored `true` back off, not merely fail to turn it on.
    const askOff = resolveBrowserDownloadPolicy(
      { [BROWSER_DOWNLOAD_ASK_ENV]: 'off' },
      { ask: true },
    )
    expect(askOff.ask).toBe(false)
    expect(askOff.askLayer).toBe('env')
  })

  it('keeps the field with the environment even when the value is unusable', () => {
    const policy = resolveBrowserDownloadPolicy(
      { [BROWSER_DOWNLOAD_ROOT_ENV]: 'downloads' },
      { root: '/tmp/from-config' },
    )
    expect(policy.root).toBeUndefined()
    expect(policy.rootLayer).toBe('env')
    expect(policy.problems).toHaveLength(1)
    expect(policy.problems[0]).toContain(BROWSER_DOWNLOAD_ROOT_ENV)
  })

  it('refuses a relative stored root, naming the file rather than the variable', () => {
    const policy = resolveBrowserDownloadPolicy({}, { root: 'downloads' })
    expect(policy.root).toBeUndefined()
    expect(policy.rootLayer).toBe('config')
    expect(policy.problems).toHaveLength(1)
    expect(policy.problems[0]).toContain('config.json browserDownload.root')
    expect(policy.problems[0]).not.toContain(BROWSER_DOWNLOAD_ROOT_ENV)
  })

  it('changes nothing when the file is empty too', () => {
    const policy = resolveBrowserDownloadPolicy({}, { root: '   ', ask: false })
    expect(policy.root).toBeUndefined()
    expect(policy.ask).toBe(false)
    expect(policy.rootLayer).toBeUndefined()
    expect(policy.problems).toEqual([])
  })

  it('describes the stored value and the value in force separately', () => {
    const overridden = describeBrowserDownloadSettings(
      { root: '/tmp/from-config', ask: true },
      { [BROWSER_DOWNLOAD_ROOT_ENV]: '/tmp/from-env' },
    )
    // What the user typed is echoed back, so the field does not silently
    // rewrite itself to the operator's value.
    expect(overridden.root).toBe('/tmp/from-config')
    expect(overridden.effectiveRoot).toBe('/tmp/from-env')
    expect(overridden.rootFromEnv).toBe(true)
    // The switch was NOT overridden, so its own control stays live.
    expect(overridden.askFromEnv).toBe(false)
    expect(overridden.effectiveAsk).toBe(true)

    const plain = describeBrowserDownloadSettings({}, {})
    expect(plain).toEqual({
      root: '',
      ask: false,
      effectiveRoot: '',
      effectiveAsk: false,
      rootFromEnv: false,
      askFromEnv: false,
      problems: [],
    })
  })
})
