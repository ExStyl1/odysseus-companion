/**
 * R21 — plan mode stops blocking shell commands outright.
 *
 * The whole line below is the anchor; the number is only a convenience:
 * `permission-modes.md:240` on the 2026-08-23 fetch, where the `:156` this file
 * used to cite is a VS Code UI-label table row.
 *
 *   "When auto mode is available and the `useAutoModeDuringPlan` setting is on,
 *   which it is by default, the classifier reviews shell commands during
 *   planning instead of prompting you. Approved commands run, and rejected ones
 *   are blocked. Otherwise, commands outside the built-in read-only set prompt
 *   for approval, including when the sandbox's auto-allow mode is enabled."
 *
 * Both branches end in a decision the mode gate cannot make, so both arrive
 * here as the same answer: needs approval, marked as plan mode's shell band.
 * `safe` keeps the outright block — the sentence is about plan mode only.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { shouldAllowToolInMode } from '../mode-manager.ts';
import { parsePermissionsJson, permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';

// P2.254: every `check(...)` below reaches `getDeniedPathViolation` ->
// `extractPowerShellWriteTarget`, which spawns `powershell-parser.ps1` on any
// host with a real PowerShell (P2.241 owns the ungated spawn itself). One spawn
// is 0.69-0.88s idle, so bun's 5s default sits BELOW this file's resting cost
// and manufactures its own failures — measured here as three 5.0-5.4s "timed out
// after 5000ms" on cases that assert instantly. Until this defect was fixed the
// spawn never happened (the validator THREW instead), which is why the ceiling
// was never needed before. Same value and reason as
// `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

afterEach(() => { permissionsConfigCache.clear(); });

/** A workspace whose read-only allowlist actually admits something. */
function context(): PermissionsContext {
  return {
    workspaceRootPath: '/nonexistent/plan-shell-review',
    pinnedRevision: 'gen',
    pinnedConfigs: [{
      config: parsePermissionsJson(JSON.stringify({
        allowedBashPatterns: ['^git status\\b', '^ls\\b'],
      })),
      scope: 'workspace' as const,
    }],
  };
}

const check = (command: string, mode: 'plan') =>
  shouldAllowToolInMode('Bash', { command }, mode, {
    permissionsContext: context(),
    allowPlanShellReview: true,
  });

describe('plan mode hands a non-read-only shell command up for approval', () => {
  it('a read-only command still runs with no approval at all', () => {
    expect(check('git status', 'plan')).toEqual({ allowed: true });
    expect(check('ls -la', 'plan')).toEqual({ allowed: true });
  });

  it.each([
    ['a plain mutation', 'npm install'],
    ['a redirect', 'echo hi > /tmp/out'],
  ])('%s is allowed-with-approval and marked as the shell band', (_label, command) => {
    const result = check(command, 'plan');
    expect(result.allowed).toBe(true);
    expect(result).toMatchObject({ requiresPermission: true, planShellReview: true });
    // The rejection text is carried through as the approval description, so the
    // human (or the judge) sees exactly why the read-only set refused it.
    expect(typeof (result as { description?: string }).description).toBe('string');
  });

  // F1.1050 (DN-272) deleted this file's "Explore mode is untouched — it still blocks outright" arm with the
  // retired mode; plan's own outright block for host-side callers is the next test.

  it('a host-side caller keeps plan mode\'s outright block', () => {
    // The band sentence ("the classifier reviews shell commands during planning
    // instead of prompting you", `permission-modes.md:240` on the 2026-08-23
    // fetch) is about the commands Claude runs while planning.
    // A skill context command and the composer shell are not those and cannot
    // reach the classifier, so they leave the band unset and plan mode refuses
    // (a command hook no longer reaches plan mode: F1.758, commandHookGateMode).
    const result = shouldAllowToolInMode('Bash', { command: 'npm install' }, 'plan', {
      permissionsContext: context(),
    });
    expect(result.allowed).toBe(false);
  });

  it('a deny rule still blocks in plan mode, before the band is reached', () => {
    const denied = shouldAllowToolInMode('Bash', { command: 'npm install' }, 'plan', {
      allowPlanShellReview: true,
      permissionsContext: {
        workspaceRootPath: '/nonexistent/plan-shell-review-deny',
        pinnedRevision: 'gen',
        pinnedConfigs: [{
          config: parsePermissionsJson(JSON.stringify({
            toolRules: [{ pattern: 'Bash', action: 'deny' }],
          })),
          scope: 'workspace' as const,
        }],
      },
    });
    expect(denied.allowed).toBe(false);
  });

  it('a file write is still blocked outright — the sentence is about shell commands', () => {
    const result = shouldAllowToolInMode('Write', { file_path: '/repo/src/a.ts' }, 'plan', {
      permissionsContext: context(),
      allowPlanShellReview: true,
    });
    expect(result.allowed).toBe(false);
  });
});
