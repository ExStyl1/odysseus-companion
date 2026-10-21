/**
 * lint-package — run ESLint over one workspace package and refuse a run that
 * linted NOTHING.
 *
 * P2.358. P2.319 built a check that every workspace package has an eslint
 * config and that something invokes it. It cannot see one level down: a config
 * whose `files` array matches no file lints zero files, prints zero bytes and
 * exits 0 — byte-identical to a package that linted 800 files clean. That is
 * the same silent exemption P2.319 was written to end, one level up.
 *
 * ESLint already knows the number: a formatter is handed one `results` entry
 * per linted file. `eslint-lint-proof-formatter.mjs` writes it out; this script
 * reads it and turns a zero into a non-zero exit.
 *
 * P2.353 rides along: a lint run killed mid-flight (exit >= 128, or a signal —
 * 134 is what Bun does on OOM) is reported as KILLED in words, not left as a
 * number a caller can mistake for success.
 *
 * ESLint runs through its own CLI rather than its Node API on purpose. The API
 * would be one config-discovery difference away from linting a different file
 * set than `npx eslint` does, and a gate that lints a DIFFERENT set than the
 * developer's own command is worse than no gate. Measured: `stylish` output is
 * byte-identical with and without this wrapper (apps/electron, 819 files).
 *
 * Usage:
 *   bun scripts/lint-package.ts <package-dir> [eslint target ...]
 *
 * `<package-dir>` is repo-relative; targets default to `.` and are passed to
 * ESLint verbatim. Every argv element is repo-relative by construction — see
 * `gate-safety.ts` for the refusal that enforces it.
 */

import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GateSafetyRefusal,
  assertInsideRepo,
  assertNoHomeOrRootPath,
  createGateScratchDir,
} from './gate-safety.ts'
import { classifyRun, killedExplanation } from './gate-verdict.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const FORMATTER = join(SCRIPT_DIR, 'eslint-lint-proof-formatter.mjs')

interface Proof {
  files: number
  errors: number
  warnings: number
}

function readProof(path: string): Proof | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Proof
  } catch {
    return null
  }
}

/**
 * The targets the package's OWN `lint:*` script passes, or `null`.
 *
 * D1.304. `bun scripts/lint-package.ts apps/electron` with no target died —
 * V8 `Ineffective mark-compacts near heap limit` at 4 049 MB, then this script's
 * own KILLED line — while `lint:electron` was green, because the chain step
 * passes `src` and the bare form does not. The cause is not the package's size:
 * `apps/electron/resources/pi-agent-server/index.js` is a **25.8 MB** single-file
 * bundle staged by `electron:build:servers` (with an 8.6 MB and a 645 KB
 * sibling), and ESLint parsing a minified bundle that size is the heap death.
 * Two of the three are untracked build output, so the failure appears only on a
 * machine that has built the servers — which is why it reads as a flake.
 *
 * So the bare form now lints what the chain step lints. The lookup is the root
 * manifest's own scripts, because THAT is where a package's lint target is
 * declared; inventing a second declaration would be a second thing to maintain
 * and the day it drifted it would drift silently. `apps/electron` is the only
 * package that declares a target today (sixteen `lint:*` scripts, fifteen with
 * none), so this is a no-op everywhere else — and passing a target explicitly is
 * untouched, which is what keeps `lint:electron`'s behaviour identical.
 *
 * NOT the heap flag: `NODE_OPTIONS=--max-old-space-size` would make the bare
 * form spend minutes and gigabytes linting a bundle nobody wants linted, and it
 * would turn a loud death into a slow one. NOT chunking, for the same reason —
 * both keep the artefact in the file set.
 */
export function declaredTargets(packageDir: string, root: string = REPO_ROOT): string[] | null {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  const wanted = packageDir.replace(/\/+$/, '')
  for (const command of Object.values(manifest.scripts ?? {})) {
    const words = command.split(/\s+/)
    const at = words.findIndex(word => word.endsWith('scripts/lint-package.ts'))
    if (at === -1) continue
    const [named, ...rest] = words.slice(at + 1)
    if (named?.replace(/\/+$/, '') !== wanted) continue
    return rest.length > 0 ? rest : null
  }
  return null
}

function main(argv: readonly string[]): number {
  const packageDir = argv[0]
  if (packageDir === undefined) {
    console.error('usage: bun scripts/lint-package.ts <package-dir> [eslint target ...]')
    return 2
  }

  const declared = argv.length > 1 ? null : declaredTargets(packageDir)
  if (declared !== null) {
    console.log(
      `lint-package: no target given; using the ${declared.join(' ')} that ${packageDir}'s own lint script `
      + 'declares (D1.304 — a bare target parses the staged multi-megabyte server bundles and dies).',
    )
  }
  const targets = argv.length > 1 ? argv.slice(1) : declared ?? ['.']
  for (const target of targets) assertNoHomeOrRootPath('an ESLint target', target)

  const absolutePackageDir = assertInsideRepo(REPO_ROOT, packageDir)

  // Relative, so nothing this script executes names a home directory or the
  // filesystem root. The formatter is resolved from the package's own cwd.
  // `./` is not decoration: ESLint reads a bare `x.mjs` as the NAME of a
  // built-in formatter and looks for it inside its own package. Measured on
  // `lint:scripts`, where the package dir IS `scripts/` so the relative path
  // came out with no leading segment at all.
  const formatterPath = relative(absolutePackageDir, FORMATTER)
  const formatterArg = formatterPath.startsWith('.') ? formatterPath : `./${formatterPath}`
  assertNoHomeOrRootPath('the formatter path', formatterArg)

  const scratch = createGateScratchDir(REPO_ROOT, 'lint-proof')
  const proofFile = join(scratch.absolute, 'proof.json')

  try {
    const command = ['npx', 'eslint', ...targets, '--format', formatterArg]
    for (const part of command) assertNoHomeOrRootPath('an ESLint argv element', part)

    const started = Date.now()
    const run = Bun.spawnSync(command, {
      cwd: absolutePackageDir,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, NESSY_ESLINT_PROOF_FILE: proofFile },
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    const verdict = classifyRun(run.exitCode, run.signalCode)

    if (verdict.kind === 'killed') {
      console.error(`\nlint-package: ${killedExplanation(`${packageDir} lint after ${seconds}s`, verdict)}`)
      return 1
    }

    const proof = readProof(proofFile)

    if (proof === null) {
      console.error(
        `\nlint-package: ${packageDir} produced no proof file, so ESLint's formatter never ran.\n` +
        `  ESLint exited ${run.exitCode}. Without the formatter this script cannot tell a clean\n` +
        '  run from a run that linted nothing, which is the whole reason it exists — so it\n' +
        '  fails rather than guess.',
      )
      return 1
    }

    if (proof.files === 0) {
      console.error(
        `\nlint-package: ${packageDir} linted 0 FILES.\n` +
        '  ESLint exited 0 and printed nothing, which is indistinguishable from a clean run —\n' +
        '  that is the defect, not the symptom. The config exists and was invoked; it just\n' +
        `  matches nothing. Check the \`files\` patterns in ${packageDir}/eslint.config.mjs and\n` +
        `  the targets passed here (${targets.join(' ')}).`,
      )
      return 1
    }

    console.log(
      `lint-package: ${packageDir} — ${proof.files} files linted, ` +
      `${proof.errors} errors, ${proof.warnings} warnings, ${seconds}s.`,
    )
    return run.exitCode ?? 1
  } finally {
    rmSync(scratch.absolute, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

export { main as lintPackage }
