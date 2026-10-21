/**
 * F1.103 (origin D1.421) — assert a persisted Bash rule by what it GRANTS, not by
 * how it is spelled.
 *
 * A suite that pins the exact rule a click writes — `['Bash(npm run build *)']` —
 * cannot tell a NARROWING from a regression: `permission-remember.test.ts`'s pin
 * sat green until D1.404 narrowed the rule to the session key, and then read the
 * safety fix as a defect. What such a suite means is two-sided, so it is asserted
 * two-sided here: the rules must still GRANT the command that was approved (a
 * regression that writes nothing, or the wrong thing, fails), and must NOT grant
 * a wider sibling of it (a widening back to `Bash(npm *)` fails). A narrower rule
 * passes both, which is the direction the product is allowed to move without
 * editing a test.
 *
 * "Grants" is answered by the reader that makes the rule matter — the compiled
 * permission DSL the pi and codex gates evaluate `.claude/settings.local.json`
 * through (`permission-dsl.ts`, via `parseClaudeRuleString`) — never by a string
 * model of the rule syntax written here.
 *
 * NOT for a suite whose SUBJECT is the width — `bash-always-allow-dangerous-prefix.test.ts`
 * pins widths on purpose — and NOT for a writer that is handed its rules
 * (`claude-settings-store.test.ts`, D1.421's own negative control).
 */
import { parseClaudeRuleString } from '@nessy-agent/shared/agent/pi-harness/claude-permission-rules'
import {
  compilePermissionDslV1,
  evaluatePermissionDslV1,
  type PermissionDslLayerInputV1,
} from '@nessy-agent/shared/agent/pi-harness/permission-dsl'

/** Do these persisted allow rules, read back by the permission DSL, allow `command`? */
export function persistedRulesAllow(rules: readonly string[], command: string): boolean {
  const document = {
    version: 1,
    rules: rules.flatMap((text, index) => {
      const parsed = parseClaudeRuleString(text, 'allow').rule
      return parsed ? [{ id: `persisted-${index}`, text, ...parsed }] : []
    }),
  }
  const layer = { scope: 'project', sourceDigest: 'persisted-rules', document } as unknown as PermissionDslLayerInputV1
  const program = compilePermissionDslV1({ generation: 'width-bound', projectTrusted: true, layers: [layer] })
  const verdict = evaluatePermissionDslV1(program, {
    generation: 'width-bound',
    semanticId: 'bash',
    toolName: 'Bash',
    input: { command },
    cwd: '/repository',
  })
  return verdict.action === 'allow'
}
