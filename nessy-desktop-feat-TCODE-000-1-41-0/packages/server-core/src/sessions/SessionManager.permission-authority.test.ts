import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('SessionManager Pi permission authority composition', () => {
  test('injects one server service into managed normal and summary bare Pi runtimes only', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    expect(source).toContain("const piPermissionService = provider === 'pi'")
    expect(source).toContain('permissionServicePort: piPermissionService')
    expect(source).toContain("contextProfile: provider === 'pi' ? 'normal' : undefined")
    expect(source).not.toContain("provider === 'pi' || provider === 'claude'")
    expect(source).toContain("...(provider === 'pi'")
    // P3.256 — asserted ABSENT, not merely un-asserted. The field this line used
    // to pin was declared on two option surfaces and read on no path, and `tsc`
    // does not excess-property-check a value arriving through a conditional
    // spread — so nothing but this row can tell a re-added `decisionMergePolicy`
    // from a working one.
    //
    // Matched as CODE (a line that begins with the key and a colon), never as a
    // substring: the removal site carries a comment naming the field, and a bare
    // `not.toContain` would be satisfied only by deleting the explanation of why
    // the line is gone — which is how a removal loses its reason.
    expect(source).not.toMatch(/^\s*decisionMergePolicy\s*:/m)
    expect(source).toContain("const summaryPermissionService = backendContext.provider === 'pi'")
    expect(source).toContain('permissionServicePort: summaryPermissionService')
    expect(source).toContain("contextProfile: backendContext.provider === 'pi' ? 'bare' : undefined")
    expect(source).toContain("...(!AGENT_FLAGS.defaultModesEnabled ? {} : {")
  })

  test('routes the existing renderer approval response into the server-owned resolver', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    expect(source).toContain('this.directPermissionResolvers.set(request.decisionId')
    // 2026-09-11 (W12-c) · pinned as an OPEN argument list. The closing paren
    // made this a pin on the resolver's ARITY, and the arity is not what the
    // row is about: `e08f51aa7` (P6.963) added `options?.askUserAnswer` and
    // `options?.comment` to the same call, so the route was intact and the pin
    // read as a routing regression. What is asserted is that the renderer's
    // answer AND its edited input reach the server-owned resolver; a fifth
    // answer field arriving later is this row's subject, not its enemy.
    expect(source).toContain('directResolver.resolve(allowed, options?.updatedInput')
    expect(source).not.toContain('permissionServicePort: provider !==')
  })
})
