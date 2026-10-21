/**
 * UA12.70 `[security]` — the Always Allow key equals the click (SEC-1).
 *
 * Measured at HEAD `581f78cdc` by `probe-remember-key.ts` (the 1.43.0 draft's
 * security reader, re-run by lane UA-cr7 on 2026-10-02): one Always Allow on
 * `git clean -n`, `git branch`, `git stash`, `git tag`, `git restore --staged a`,
 * `node -e "…"`, `python3 -c "…"`, `python3 script.py` or `npx prettier --check .`
 * stored a key (`git clean`, `node`, `python3 script.py`, `npx prettier`, …)
 * under which `git clean -fdx`, `git branch -D main`, `git stash drop`,
 * `git tag -d v1`, `git restore .`, `node evil.js`, `python3 script.py
 * --delete-all` and `npx prettier --write .` then ran with NO card; on Pi and
 * codex the same click also wrote the durable `Bash(<key> *)`.
 *
 * The classification is upstream's: craft-agents-oss v0.14.0
 * `packages/shared/src/agent/core/permission-remember.ts` `getBashRememberKey`
 * and its test `packages/shared/src/agent/core/__tests__/permission-remember.test.ts`
 * (Apache-2.0; the cases below are copied and adapted — our shells stay
 * keyless (D1.403) where upstream keys `bash -c` by its exact argv, and a bare
 * CLI name is keyed by its exact argv where upstream keys the name).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as dc from '../dangerous-commands.ts'
import { PermissionManager } from '../permission-manager.ts'
import { bashSessionGrantCoversLine, shouldPromptInAskMode } from '../pre-tool-use.ts'
import { matchClaudeBashRule } from '../../pi-harness/claude-bash-rule.ts'

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'ua1270-ws-'))
const context = { workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [] }

const exact = (...argv: string[]) => `exact:${JSON.stringify(argv)}`
const base = (command: string) => command.trim().split(/\s+/)[0] ?? ''
const keyOf = (command: string) => dc.bashSessionWhitelistKey(command, base(command))

function manager(): PermissionManager {
  return new PermissionManager({ workspaceId: 'ws-ua1270', sessionId: 'sess-ua1270', workspaceRootPath: WORKSPACE_ROOT })
}

/** One Always Allow on `approved` (the key the click mints), then: does `later` run with no card? */
function laterRunsCardFree(approved: string, later: string): boolean {
  const m = manager()
  const key = keyOf(approved)
  if (key) m.whitelistCommand(key)
  return bashSessionGrantCoversLine(later, k => m.isCommandWhitelisted(k), l => m.isDangerousCommand(l)) !== null
}

describe('UA12.70 — the key (upstream v0.14.0 getBashRememberKey, adapted)', () => {
  it.each([
    ['git commit -m "wip"', 'git commit'],
    ['npm test', 'npm test'],
    ['npm install lodash --save-dev', 'npm install lodash'],
    ['aws s3 ls', 'aws s3 ls'],
    ['gh pr merge 12 --squash', 'gh pr merge 12'],
    ['gcloud compute instances list', 'gcloud compute instances list'],
    ['/usr/bin/git commit -m x', '/usr/bin/git commit'],
    ['mkdir -p out', 'mkdir'],
    ['touch a.txt', 'touch'],
    // Ours, not upstream's: a launcher is keyed by its exact argv (reason (b), `KEYED_BY_NAME`).
    ['open README.md', exact('open', 'README.md')],
    ['code --install-extension x.vsix', exact('code', '--install-extension', 'x.vsix')],
  ])('%s -> %s', (command, key) => {
    expect(keyOf(command)).toBe(key)
  })

  it('keys commands whose flags or arguments decide what they do by the exact argv', () => {
    expect(keyOf('tar -tf a.tar')).toBe(exact('tar', '-tf', 'a.tar'))
    expect(keyOf('psql -c "SELECT 1"')).toBe(exact('psql', '-c', 'SELECT 1'))
    expect(keyOf('python script.py --dry-run')).toBe(exact('python', 'script.py', '--dry-run'))
    expect(keyOf('npm run build')).toBe(exact('npm', 'run', 'build'))
    expect(keyOf('docker run ubuntu ls -la')).toBe(exact('docker', 'run', 'ubuntu', 'ls', '-la'))
    expect(keyOf('npx rimraf dist')).toBe(exact('npx', 'rimraf', 'dist'))
    expect(keyOf('node -e "console.log(1)"')).toBe(exact('node', '-e', 'console.log(1)'))
    // A bare CLI name is its own exact argv: one click on `git` buys `git`, never every git subcommand.
    expect(keyOf('npm')).toBe(exact('npm'))
  })

  it.each([
    'git push --force origin main', 'git reset --hard HEAD~3', 'git switch -f main', 'git stash drop',
    '/usr/bin/git push', 'kubectl delete pod web', 'terraform apply', 'npm publish',
    'git clean -n', 'git branch', 'git stash', 'git tag', 'git restore --staged a.txt',
    'aws s3 rm --recursive s3://prod', 'aws s3 rb s3://prod --force', 'aws ec2 terminate-instances --instance-ids i-1',
    'gh repo delete me/app --yes', 'docker volume rm data', 'docker system prune -a', 'docker run ubuntu rm tmpfile',
    'heroku apps:destroy --app x', 'rm -rf build', 'sudo git commit -m x', 'pkexec apt install x', 'env FOO=1 make',
    'xargs rm', 'bash -c "echo hi"', 'sh -c "npm test"', 'git status && rm -rf ~', 'npm test; rm -rf ~',
    'cat notes.txt | sh', 'echo hi > file.txt', 'FOO=bar make deploy', 'git commit -m "$(whoami)"',
    'git commit -m x &', 'git -C /repo push', 'git -C /repo status', 'gh api -X DELETE repos/o/r', 'gh api repos/o/r',
    '"git" push origin main', '',
  ])('%s -> no key', (command) => {
    expect(keyOf(command)).toBeNull()
  })

  it('DANGEROUS_COMMANDS is upstream v0.14.0 grown list, verbatim (QUESTIONS.md U43-SEC.1 default (a))', () => {
    for (const entry of [
      'git clean', 'git restore', 'git switch', 'git stash', 'git branch', 'git tag', 'git rm', 'git worktree', 'git gc',
      'git reflog', 'kubectl apply', 'kubectl delete', 'kubectl drain', 'kubectl replace', 'helm install', 'helm upgrade',
      'helm uninstall', 'helm rollback', 'terraform apply', 'terraform destroy', 'tofu apply', 'tofu destroy', 'pulumi up',
      'pulumi destroy', 'npm publish', 'npm unpublish', 'pnpm publish', 'yarn publish', 'bun publish', 'cargo publish',
      'gem push', 'docker push', 'podman push', 'netlify deploy', 'fly deploy', 'flyctl deploy', 'wrangler deploy',
      'wrangler publish', 'firebase deploy',
    ]) expect([entry, dc.DANGEROUS_COMMANDS.includes(entry)]).toEqual([entry, true])
    expect(dc.DANGEROUS_COMMANDS.length).toBe(68)
  })
})

describe('UA12.70 — what one click then buys (the SEC-1 probe pairs)', () => {
  it.each([
    ['git status', 'git push --force'],
    ['git commit -m x', 'git push --force origin main'],
    ['git clean -n', 'git clean -fdx'],
    ['git branch', 'git branch -D main'],
    ['git stash', 'git stash drop'],
    ['git stash', 'git stash clear'],
    ['git tag', 'git tag -d v1'],
    ['git restore --staged a.txt', 'git restore .'],
    ['node -e "console.log(1)"', 'node -e "require(\'fs\').rmSync(\'/x\',{recursive:true})"'],
    ['node -e "console.log(1)"', 'node evil.js'],
    ['python3 -c "print(1)"', 'python3 -c "import shutil; shutil.rmtree(\'x\')"'],
    ['python3 script.py', 'python3 script.py --delete-all'],
    ['npx prettier --check .', 'npx prettier --write .'],
    ['docker compose ps', 'docker compose down -v'],
    ['kubectl get pods', 'kubectl delete pods --all'],
    ['npm test', 'npm publish'],
    ['npm install lodash', 'npm install lodash evil-pkg'],
  ])('approve %s -> %s still cards', (approved, later) => {
    expect(laterRunsCardFree(approved, later)).toBe(false)
  })

  it('and the same command again runs card-free — the positive arm', () => {
    expect(laterRunsCardFree('git status', 'git status -s')).toBe(true)
    expect(laterRunsCardFree('npm test', 'npm test')).toBe(true)
    expect(laterRunsCardFree('npm test', 'npm test --watch')).toBe(true)
    expect(laterRunsCardFree('git commit -m x', 'git commit -m y')).toBe(true)
    expect(laterRunsCardFree('node -e "console.log(1)"', 'node -e "console.log(1)"')).toBe(true)
    expect(laterRunsCardFree('python3 script.py', 'python3 script.py')).toBe(true)
  })

  it('an exact key keeps its case: approving `python3 x.py -n` does not buy `python3 x.py -N`', () => {
    expect(laterRunsCardFree('python3 x.py -n', 'python3 x.py -n')).toBe(true)
    expect(laterRunsCardFree('python3 x.py -n', 'python3 x.py -N')).toBe(false)
  })
})

describe('UA12.70 — the card: no key, no Always Allow', () => {
  const card = (command: string) => shouldPromptInAskMode('Bash', { command }, manager(), context) as
    { noAlwaysAllow?: true } | null

  it('a command with a key offers Always Allow', () => {
    expect(card('npm test')).not.toBeNull()
    expect(card('npm test')?.noAlwaysAllow).toBeUndefined()
    expect(card('node -e "console.log(1)"')?.noAlwaysAllow).toBeUndefined()
  })

  it('a wrapper, gh api or a dangerous command mints no key, and the card says so', () => {
    expect(card('env FOO=1 npm test')?.noAlwaysAllow).toBe(true)
    expect(card('gh api repos/o/r')?.noAlwaysAllow).toBe(true)
    expect(card('git push --force')?.noAlwaysAllow).toBe(true)
    expect(card('bash -c "npm test"')?.noAlwaysAllow).toBe(true)
  })
})

describe('UA12.70 — the durable rule text equals the approved class', () => {
  const ruleOf = (command: string) => {
    const key = keyOf(command)
    return key && typeof (dc as Record<string, unknown>).bashAlwaysAllowRuleContent === 'function'
      ? (dc as unknown as { bashAlwaysAllowRuleContent: (c: string, k: string) => string | null }).bashAlwaysAllowRuleContent(command, key)
      : null
  }

  it('an exact key persists as the whole line, with no ` *`, and matches exactly', () => {
    const rule = ruleOf('node -e "console.log(1)"')
    expect(rule).toBe('node -e "console.log(1)"')
    expect(matchClaudeBashRule(rule ?? '', 'node -e "console.log(1)"', { ruleAction: 'allow' })).toBe('match')
    expect(matchClaudeBashRule(rule ?? '', 'node evil.js', { ruleAction: 'allow' })).toBe('no-match')
    expect(matchClaudeBashRule(ruleOf('python3 script.py') ?? '', 'python3 script.py --delete-all', { ruleAction: 'allow' })).toBe('no-match')
  })

  it('UA12.84 — a leading-words key persists as the exact line; a by-name key as `<name> *` (the control)', () => {
    expect([ruleOf('npm test --watch'), ruleOf('git commit -m x'), ruleOf('touch a.txt')]).toEqual(['npm test --watch', 'git commit -m x', 'touch *'])
    expect(matchClaudeBashRule(ruleOf('npm install lodash') ?? '', 'npm install lodash evil-pkg', { ruleAction: 'allow' })).toBe('no-match')
  })

  // UA12.70 follow-up — a quoted `*` passes the argv parser and gets an exact
  // key, but the rule grammar reads `*` anywhere as a wildcard
  // (permissions.md#bash), so the line written verbatim matched
  // `node -e "x;<anything>"`. No exact rule text can say it, so no durable rule:
  // the session store (key equality) keeps the grant.
  it('an exact line with a quoted `*` persists NO durable rule; its session key stays exact', () => {
    for (const command of [
      'node -e "x*"',
      `python3 -c "import glob; print(glob.glob('*.py'))"`,
      `ls 'x*y'`,
    ]) {
      expect(keyOf(command)).not.toBeNull()
      expect(ruleOf(command)).toBeNull()
    }
    expect(laterRunsCardFree('node -e "x*"', 'node -e "x*"')).toBe(true)
    expect(laterRunsCardFree('node -e "x*"', `node -e "x;require('fs').rmSync('/',{recursive:true})"`)).toBe(false)
  })
})
