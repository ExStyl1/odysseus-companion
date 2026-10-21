import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const electronRoot = join(import.meta.dir, '..', '..', '..')
const binDir = join(electronRoot, 'resources', 'bin')
let tempDirectory = ''

afterEach(() => {
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
  tempDirectory = ''
})

describe('packaged plugin JavaScript runtime', () => {
  it('ships Bun and the managed node shim outside app.asar on every platform without a global PATH injection', () => {
    const builder = readFileSync(join(electronRoot, 'electron-builder.yml'), 'utf8')
    const main = readFileSync(join(electronRoot, 'src', 'main', 'index.ts'), 'utf8')
    expect(builder.match(/from: vendor\/bun\/bun\n\s+to: vendor\/bun\/bun/g)).toHaveLength(2)
    expect(builder).toContain('from: vendor/bun/bun.exe\n      to: vendor/bun/bun.exe')
    expect(builder.match(/from: resources\/bin\/node\n\s+to: bin\/node/g)).toHaveLength(2)
    expect(builder).toContain('from: resources/bin/node.cmd\n      to: bin/node.cmd')
    expect(builder).toContain('- "!vendor/bun/**/*"')
    expect(main).not.toContain("join(process.resourcesPath, 'bin') : binDir")
  })

  it('stages the pinned uv runtime for macOS, Linux, and Windows packages', () => {
    const mac = readFileSync(join(electronRoot, 'scripts', 'build-dmg.sh'), 'utf8')
    const linux = readFileSync(join(electronRoot, 'scripts', 'build-linux.sh'), 'utf8')
    const windows = readFileSync(join(electronRoot, 'scripts', 'build-win.ps1'), 'utf8')

    expect(mac).toContain('downloadUv({ platform: "darwin"')
    expect(mac).toContain('resources/bin/darwin-${ARCH}/uv')
    expect(linux).toContain('downloadUv({ platform: "linux"')
    expect(linux).toContain('resources/bin/linux-${ARCH}/uv')
    expect(windows).toContain('downloadUv({ platform: "win32"')
    expect(windows).toContain('resources\\bin\\win32-x64\\uv.exe')
  })

  it('runs the Honey activate, next SessionStart, and deactivate cycle through a scoped managed Bun PATH', () => {
    if (process.platform === 'win32') return
    tempDirectory = mkdtempSync(join(tmpdir(), 'nessy-honey-node-smoke-'))
    const statePath = join(tempDirectory, 'state')
    const stateScript = join(tempDirectory, 'honey-state.js')
    const sessionScript = join(tempDirectory, 'honey-session.js')
    writeFileSync(stateScript, [
      "const fs = require('node:fs')",
      `const path = ${JSON.stringify(statePath)}`,
      "if (process.argv[2] !== 'set') process.exit(2)",
      "fs.writeFileSync(path, process.argv[3] || 'full')",
    ].join('\n'))
    writeFileSync(sessionScript, [
      "const fs = require('node:fs')",
      `const path = ${JSON.stringify(statePath)}`,
      "const state = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''",
      "if (state !== 'off') process.stdout.write(state)",
    ].join('\n'))
    chmodSync(join(binDir, 'node'), 0o755)
    const env = {
      ...process.env,
      NESSY_BUN: process.execPath,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_CONFIG_DIR: tempDirectory,
    }
    const run = (command: string) => spawnSync('/bin/sh', ['-c', command], {
      cwd: tempDirectory,
      env,
      encoding: 'utf8',
    })

    expect(run(`node ${JSON.stringify(stateScript)} set full`).status).toBe(0)
    expect(run(`node ${JSON.stringify(sessionScript)}`).stdout).toBe('full')
    expect(run(`node ${JSON.stringify(stateScript)} set off`).status).toBe(0)
    expect(run(`node ${JSON.stringify(sessionScript)}`).stdout).toBe('')
  })
})
