import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManagedPiPolicyTolerantV1 } from '../../agent/pi-harness/managed-policy.ts'
import {
  classifyManagedApproval,
  managedPayloadDigest,
  MANAGED_ENV_SAFE_ALLOWLIST,
  renderManagedApprovalSummary,
  resolveManagedApproval,
} from '../managed-approval.ts'
import { classifyManagedEnvVar, isWithheldManagedEnvVar } from '../managed-env.ts'
import {
  initializeManagedDeliveryFromCache,
  MANAGED_DELIVERY_CACHE_FILENAME,
  readManagedDeliveryCache,
  refreshManagedDelivery,
  resetManagedDeliverySession,
  salvageDeliveredPayload,
  setManagedDeliveryApproval,
} from '../managed-delivery.ts'

const parse = (document: unknown) =>
  parseManagedPiPolicyTolerantV1(document, { source: 'test' }).policy

let dir: string
let cachePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nessy-managed-approval-'))
  cachePath = join(dir, MANAGED_DELIVERY_CACHE_FILENAME)
  resetManagedDeliverySession()
})

afterEach(() => {
  resetManagedDeliverySession()
  rmSync(dir, { recursive: true, force: true })
})

describe('the categories `#security-approval-dialogs` lists', () => {
  test('shell: unsandboxed execution, sandbox exclusions and allow rules', () => {
    const request = classifyManagedApproval(parse({
      schemaVersion: 1,
      sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['git *'] },
      permissionDsl: { version: 1, rules: [{ id: 'a', action: 'allow', match: { kind: 'tool', semanticId: 'Bash' } }] },
    }))
    expect(request!.items.filter(item => item.category === 'shell').map(item => item.field)).toEqual([
      'sandbox.allowUnsandboxedCommands',
      'sandbox.excludedCommands',
      'permissionDsl.rules',
    ])
  })

  test('shell: a deny-only policy needs no approval — denies only subtract', () => {
    expect(classifyManagedApproval(parse({
      schemaVersion: 1,
      permissionDsl: { version: 1, rules: [{ id: 'd', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }] },
      deniedMcpServers: ['blocked'],
      sandbox: { allowUnsandboxedCommands: false },
    }))).toBeNull()
  })

  /**
   * P6.1046 — the third bullet, which the page added at v2.1.251.
   *
   * `server-managed-settings.md#security-approval-dialogs`: "**Sandbox network
   * and isolation settings**: sandbox settings that let the sandbox proxy read,
   * reroute, or authenticate traffic, or that weaken the sandbox's isolation …
   * Before v2.1.251, Claude Code applied these settings without approval".
   *
   * The bullet names eleven keys and we carry exactly one of them, so the pair
   * of tests below is the whole bullet: the positive is the carrier, and the
   * control is the other ten, asserted through the PARSER rather than through
   * `DOCUMENTED_UNCARRIED_SANDBOX_KEYS`'s membership — a name removed from that
   * set would then have to keep stripping to stay green, which is the outcome
   * this cares about.
   */
  test('sandbox: a delivered `filesystem.disabled` reaches the dialog; the locking pole does not', () => {
    const request = classifyManagedApproval(parse({
      schemaVersion: 1,
      sandbox: { filesystem: { disabled: true } },
    }))
    expect(request!.items.map(item => ({ category: item.category, field: item.field }))).toEqual([
      { category: 'sandbox', field: 'sandbox.filesystem.disabled' },
    ])
    const rendered = renderManagedApprovalSummary(request!)
    expect(rendered).toContain('sandbox.filesystem.disabled')
    // The consequence is named, because "filesystem isolation off" and "this app
    // can no longer protect its own settings files" read very differently.
    expect(rendered).toContain('configuration and code')

    // `false` is the administrator KEEPING filesystem isolation on. It only ever
    // subtracts, like a `deny` rule, so it needs no human — and it is the pole
    // `claude-managed-settings.ts` actually sends to the child.
    expect(classifyManagedApproval(parse({
      schemaVersion: 1,
      sandbox: { filesystem: { disabled: false } },
    }))).toBeNull()
  })

  test('sandbox: the bullet\'s other ten keys are stripped before the dialog sees them', () => {
    const delivered: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['sandbox.network.tlsTerminate', { network: { tlsTerminate: true } }],
      ['sandbox.network.httpProxyPort', { network: { httpProxyPort: 8080 } }],
      ['sandbox.network.socksProxyPort', { network: { socksProxyPort: 1080 } }],
      ['sandbox.credentials', { credentials: { envVars: ['ANTHROPIC_API_KEY'] } }],
      ['sandbox.allowAppleEvents', { allowAppleEvents: true }],
      ['sandbox.enableWeakerNestedSandbox', { enableWeakerNestedSandbox: true }],
      ['sandbox.enableWeakerNetworkIsolation', { enableWeakerNetworkIsolation: true }],
      ['sandbox.network.allowAllUnixSockets', { network: { allowAllUnixSockets: true } }],
      ['sandbox.network.allowUnixSockets', { network: { allowUnixSockets: ['/tmp/agent.sock'] } }],
      ['sandbox.network.allowMachLookup', { network: { allowMachLookup: ['com.apple.example'] } }],
    ]
    for (const [dotted, sandbox] of delivered) {
      const policy = parse({ schemaVersion: 1, sandbox })
      const leaf = dotted.split('.').at(-1)!
      // One assertion per key, naming the key, so a failure says which one.
      expect({
        dotted,
        carried: JSON.stringify(policy.sandbox ?? {}).includes(leaf),
        request: classifyManagedApproval(policy),
      }).toEqual({ dotted, carried: false, request: null })
    }
  })

  test('env: a variable outside the safe allowlist needs approval, one inside does not', () => {
    expect(classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' },
    }))).toBeNull()

    const request = classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf', HTTPS_PROXY: 'http://p:3128' },
    }))
    expect(request!.items.map(item => item.field)).toEqual(['env.HTTPS_PROXY'])
    expect(request!.items[0]!.detail).toContain('transport')
  })

  /**
   * P3.210 — the page's one unconditional sentence about this dialog.
   *
   * `server-managed-settings.md#environment-variables-and-the-approval-dialog`:
   * "Other delivered variables can require the user's approval before they take
   * effect; a non-empty proxy, base-URL, or `OTEL_EXPORTER_OTLP_ENDPOINT` value
   * always does."
   *
   * The endpoint is asserted by NAME rather than through the allowlist's
   * membership, so deleting the name from the set is not enough to make this
   * pass again — the classifier has to actually raise the item. The empty-value
   * case is ours (the page grants a dialog for a non-empty value and leaves the
   * rest to us); it is pinned so the stricter reading cannot be relaxed by
   * accident, and `OTEL_EXPORTER_OTLP_HEADERS` rides with it because it carries
   * the credential half of the same telemetry unit.
   */
  test('P3.210: the OTLP endpoint and its headers always reach the dialog', () => {
    const request = classifyManagedApproval(parse({
      schemaVersion: 1,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer hunter2',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      },
    }))
    expect(request!.items.map(item => item.field)).toEqual([
      'env.OTEL_EXPORTER_OTLP_ENDPOINT',
      'env.OTEL_EXPORTER_OTLP_HEADERS',
    ])
    // The category is named, never the value — the header line must not leak
    // the token it carries.
    expect(renderManagedApprovalSummary(request!)).not.toContain('hunter2')

    // Stricter than the page's "non-empty": an empty endpoint is still an
    // administrator moving where telemetry goes.
    const empty = classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: '' },
    }))
    expect(empty!.items.map(item => item.field)).toEqual(['env.OTEL_EXPORTER_OTLP_ENDPOINT'])
  })

  /**
   * C3.291 — the TRACES batching knob, added to the safe set 2026-09-12.
   *
   * `monitoring-usage.md#traces-beta` gives it a row of its own: "Span batch
   * export interval in milliseconds (default: 5000)". It was missing while its
   * metrics sibling was present, so an operator delivering both got a dialog
   * for one of them and no stated reason for the difference.
   *
   * The NEGATIVE arm is the one that matters: widening a safe allowlist must
   * not be able to loosen the endpoint, which the page says "always" needs
   * approval. Asserted here in the same test so the two cannot drift apart.
   */
  test('C3.291: the traces export interval is dialog-free, and it does not loosen the endpoint', () => {
    expect(classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_TRACES_EXPORT_INTERVAL: '1000' },
    }))).toBeNull()

    // Both intervals together are still dialog-free — the pair this row exists
    // to make symmetric.
    expect(classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_TRACES_EXPORT_INTERVAL: '1000', OTEL_METRIC_EXPORT_INTERVAL: '10000' },
    }))).toBeNull()

    // NEGATIVE: the endpoint still raises the dialog beside it, and it is the
    // ONLY item raised — so the interval did not ride in on the endpoint's
    // approval and the endpoint did not ride out on the interval's exemption.
    const withEndpoint = classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { OTEL_TRACES_EXPORT_INTERVAL: '1000', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector' },
    }))
    expect(withEndpoint!.items.map(item => item.field)).toEqual(['env.OTEL_EXPORTER_OTLP_ENDPOINT'])

    // And it is classified beside its sibling, so `otlp-rearm`'s
    // `immediateEnvSnapshot` watches a change to it.
    expect(classifyManagedEnvVar('OTEL_TRACES_EXPORT_INTERVAL')).toBe('immediate')
    expect(classifyManagedEnvVar('OTEL_METRIC_EXPORT_INTERVAL')).toBe('immediate')
  })

  test('the safe allowlist and the withheld set are disjoint, by assertion', () => {
    for (const name of MANAGED_ENV_SAFE_ALLOWLIST) {
      expect({ name, withheld: isWithheldManagedEnvVar(name) }).toEqual({ name, withheld: false })
    }
  })

  // `claudeMd` stopped being an approval-requiring key at Claude Code v2.1.260
  // — `server-managed-settings.md#security-approval-dialogs`: "A managed
  // CLAUDE.md delivered through the `claudeMd` key doesn't require approval…
  // Before v2.1.260, a `claudeMd` value required approval too." This pin is
  // UNCHANGED by that (read 2026-09-11, P6.1038): it asserts the key is
  // STRIPPED, which is the same outcome under either rule. The `instruction`
  // category stayed while the bundle was below the reversal and left at F1.255,
  // whose lift to 2.1.267 is the one that reached 2.1.260.
  test('hook and instruction payloads are stripped before the dialog sees them (#invalid-entries-in-delivered-settings)', () => {
    const document = {
      schemaVersion: 1,
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/tmp/audit.sh' }] }] },
      claudeMd: '# org instructions',
    }
    const salvage = salvageDeliveredPayload(document)
    // The parser strips both as unknown keys, so they never reach the policy…
    expect(JSON.stringify(salvage.payload)).not.toContain('audit.sh')
    expect(JSON.stringify(salvage.payload)).not.toContain('org instructions')
    expect(salvage.drops.map(drop => drop.field)).toEqual(
      expect.arrayContaining(['hooks', 'claudeMd']),
    )
    // …and therefore never reach the approval dialog, and never execute.
    expect(classifyManagedApproval(salvage.policy, salvage.payload)).toBeNull()
  })
})

describe('the dialog never renders a delivered value', () => {
  test('summary lines carry names and categories only', () => {
    const request = classifyManagedApproval(parse({
      schemaVersion: 1,
      env: { ANTHROPIC_API_KEY: 'sk-super-secret', HTTPS_PROXY: 'http://user:hunter2@proxy:3128' },
    }))!
    const rendered = renderManagedApprovalSummary(request)
    expect(rendered).not.toContain('sk-super-secret')
    expect(rendered).not.toContain('hunter2')
    expect(rendered).toContain('ANTHROPIC_API_KEY')
    expect(rendered).toContain('credential')
  })
})

describe('the resolution matrix', () => {
  const needsApproval = { schemaVersion: 1, env: { HTTPS_PROXY: 'http://p:3128' } }
  const base = () => {
    const salvage = salvageDeliveredPayload(needsApproval)
    return { policy: salvage.policy, payload: salvage.payload }
  }

  test('approval applies, persists and records the digest', async () => {
    const resolution = await resolveManagedApproval({
      ...base(), mode: 'interactive', prompt: () => true,
    })
    expect(resolution).toMatchObject({ outcome: 'approved', apply: true, persist: true, exit: false })
    expect(resolution.approvedDigest).toBe(managedPayloadDigest(base().payload))
  })

  test('rejection exits and applies nothing (:216)', async () => {
    expect(await resolveManagedApproval({ ...base(), mode: 'interactive', prompt: () => false }))
      .toMatchObject({ outcome: 'rejected', apply: false, persist: false, exit: true })
  })

  test('a session that cannot show the dialog keeps the last approved settings (:218)', async () => {
    expect(await resolveManagedApproval({ ...base(), mode: 'interactive-unavailable' }))
      .toMatchObject({ outcome: 'deferred', apply: false, persist: false, exit: false })
  })

  test('a non-interactive run applies for that run only (:221)', async () => {
    expect(await resolveManagedApproval({ ...base(), mode: 'non-interactive' }))
      .toMatchObject({ outcome: 'run-only', apply: true, persist: false, exit: false })
  })

  test('a matching recorded digest is not re-prompted', async () => {
    let prompted = 0
    const resolution = await resolveManagedApproval({
      ...base(),
      mode: 'interactive',
      approvedDigest: managedPayloadDigest(base().payload),
      prompt: () => { prompted += 1; return true },
    })
    expect(resolution.outcome).toBe('already-approved')
    expect(prompted).toBe(0)
  })

  test('a digest recorded against a DIFFERENT payload is not honoured', async () => {
    let prompted = 0
    const resolution = await resolveManagedApproval({
      ...base(),
      mode: 'interactive',
      approvedDigest: managedPayloadDigest({ schemaVersion: 1 }),
      prompt: () => { prompted += 1; return true },
    })
    expect(resolution.outcome).toBe('approved')
    expect(prompted).toBe(1)
  })

  test('the digest is stable across key order', () => {
    expect(managedPayloadDigest({ a: 1, b: [2, 3] })).toBe(managedPayloadDigest({ b: [2, 3], a: 1 }))
    expect(managedPayloadDigest({ a: 1 })).not.toBe(managedPayloadDigest({ a: 2 }))
  })
})

describe('end to end through delivery', () => {
  const payload = { schemaVersion: 1, deniedMcpServers: ['blocked'], env: { HTTPS_PROXY: 'http://p:3128' } }
  const respond = (() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as unknown as typeof fetch

  test('a non-interactive run applies without writing the cache, and the next interactive session prompts', async () => {
    setManagedDeliveryApproval(async (salvage, context) => {
      const resolution = await resolveManagedApproval({
        policy: salvage.policy,
        payload: salvage.payload,
        mode: 'non-interactive',
        approvedDigest: context.approvedDigest,
      })
      return { apply: resolution.apply, persist: resolution.persist }
    })
    const state = await refreshManagedDelivery({ jwt: 'j', cachePath, force: true, fetchImpl: respond })
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
    expect(existsSync(cachePath)).toBe(false)

    // Next session, interactive: still unapproved, so it still prompts.
    resetManagedDeliverySession()
    let prompted = 0
    setManagedDeliveryApproval(async (salvage, context) => {
      const resolution = await resolveManagedApproval({
        policy: salvage.policy,
        payload: salvage.payload,
        mode: 'interactive',
        approvedDigest: context.approvedDigest,
        prompt: () => { prompted += 1; return true },
      })
      return {
        apply: resolution.apply,
        persist: resolution.persist,
        ...(resolution.approvedDigest === undefined ? {} : { approvedDigest: resolution.approvedDigest }),
      }
    })
    await refreshManagedDelivery({ jwt: 'j', cachePath, force: true, fetchImpl: respond })
    expect(prompted).toBe(1)
    expect(readManagedDeliveryCache(cachePath)?.approvedDigest).toBeDefined()
  })

  test('a deferred payload leaves the previously approved cache in place (:218)', async () => {
    // Approve one payload first.
    setManagedDeliveryApproval(async (salvage) => {
      const resolution = await resolveManagedApproval({
        policy: salvage.policy, payload: salvage.payload, mode: 'interactive', prompt: () => true,
      })
      return {
        apply: resolution.apply,
        persist: resolution.persist,
        ...(resolution.approvedDigest === undefined ? {} : { approvedDigest: resolution.approvedDigest }),
      }
    })
    await refreshManagedDelivery({ jwt: 'j', cachePath, force: true, fetchImpl: respond })
    const approvedCache = readManagedDeliveryCache(cachePath)!

    // A NEW payload arrives in a session that cannot show the dialog.
    resetManagedDeliverySession()
    setManagedDeliveryApproval(async (salvage, context) => {
      const resolution = await resolveManagedApproval({
        policy: salvage.policy,
        payload: salvage.payload,
        mode: 'interactive-unavailable',
        approvedDigest: context.approvedDigest,
      })
      return { apply: resolution.apply, persist: resolution.persist }
    })
    const state = await refreshManagedDelivery({
      jwt: 'j',
      cachePath,
      force: true,
      fetchImpl: (() => Promise.resolve(new Response(
        JSON.stringify({ ...payload, env: { HTTPS_PROXY: 'http://attacker:3128' } }),
        { status: 200 },
      ))) as unknown as typeof fetch,
    })

    expect(state.source).toBe('cache')
    expect(state.policy.env).toEqual({ HTTPS_PROXY: 'http://p:3128' })
    expect(readManagedDeliveryCache(cachePath)).toEqual(approvedCache)
  })

  test('a tampered cache is held back at startup rather than applied (:254)', () => {
    setManagedDeliveryApproval(async (salvage) => {
      const resolution = await resolveManagedApproval({
        policy: salvage.policy, payload: salvage.payload, mode: 'interactive', prompt: () => true,
      })
      return {
        apply: resolution.apply,
        persist: resolution.persist,
        ...(resolution.approvedDigest === undefined ? {} : { approvedDigest: resolution.approvedDigest }),
      }
    })
    return refreshManagedDelivery({ jwt: 'j', cachePath, force: true, fetchImpl: respond }).then(() => {
      const cached = readManagedDeliveryCache(cachePath)!
      // Hand-edit the payload, keeping the old approval stamp.
      Bun.write(cachePath, JSON.stringify({
        ...cached,
        payload: { ...cached.payload, env: { HTTPS_PROXY: 'http://attacker:3128' } },
      }))
      resetManagedDeliverySession()
      const state = initializeManagedDeliveryFromCache(cachePath)
      expect(state.source).toBe('none')
      expect(state.awaitingApproval).toBeDefined()
      expect(state.policy.env).toBeUndefined()
    })
  })
})
