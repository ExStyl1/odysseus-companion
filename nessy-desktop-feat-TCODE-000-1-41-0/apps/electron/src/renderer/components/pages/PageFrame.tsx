/* Copied from v0.13.4:apps/electron/src/renderer/components/pages/PageFrame.tsx (craft-agents-oss,
   Apache-2.0) by UA7.3, 2026-10-02, rebranded `@craft-agent` → `@nessy-agent`. UA9.3 restored the
   grant and action machinery UA7.3 withheld (the bridge's `action`, `action-cancel` and
   `grant-request` kinds, the rate limiter, the grant request dialog, the in-flight abort).
   Adaptations (spec §14 and §15, each named):
   - L324: `srcDoc` is `buildPageSrcdoc(content, kind)` (`shared/page-frame-csp.ts`, UA7.1) — doctype,
     the frame CSP, the WebRTC removal, then the leased bytes unchanged; upstream renders the bytes
     as-is and so inherits this window's CSP.
   - L272–L276: the `event.source` + opaque-origin check is `isFromPageFrame` (`page-frame-gates.ts`).
   - L291–L296 `open-url` (OQ-12): besides the nonce, http(s) and user activation, the frame must
     hold focus (`document.activeElement === iframe`), and the link opens only after the user
     confirms a host dialog showing the full URL (`checkPageOpenUrl`, `settlePageOpenUrl`).
   - L24 `isSafeExternalUrl` is read through `page-frame-gates.ts`.
   - L106–L111 grants: the usable grants come from the `grants` prop — the host-approvals ledger's
     grants PageView reads through `pages:listGrants` — never from `page.config.grants` (reason (b),
     spec §15); L149–L154's reconcile therefore runs on that prop.
   - L178–L182 mutating actions: user activation AND frame focus (`checkPageAction`); upstream asks
     activation alone, which a click on the host's own toolbar also satisfies.
   - L210–L229 grant requests (OQ-10): user activation AND frame focus, one dialog at a time, at most
     `GRANT_DIALOGS_PER_MINUTE` a minute (`checkPageGrantRequest`); each entry is validated BY THE HOST
     (`pages:describeGrantRequest`) before the dialog shows it, and the dialog shows that descriptor —
     for a script, the sha256 of its bytes — as the authority. An entry the host refuses is dropped.
   - L231–L258 approval: `pages:issueGrant` carries the digest of the content on screen and, for a
     script, the sha256 the dialog showed; the host refuses either one if it moved since.
   - L84–L89 `descriptorSignature` lives in `page-frame-gates.ts` (pure, tested there).
   UB14.53, 2026-10-17: v0.15.1's `PAGE_CANVAS_CLASS` (v0.15.1 L78–L84, v0.15.0's) — the frame's white canvas as a
   named constant whose guardrail waiver names our rule prefix (`nessy-styles`, UB13.14); the class is unchanged. */
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  LoadedPage,
  PageActionRequest,
  PageActionResult,
  PageDataSnapshot,
  PageKind,
  PageRenderLease,
} from '@nessy-agent/shared/pages/types'
import { isPageGrantUsable } from '@nessy-agent/shared/pages/types'
import type { PageActionGrant } from '@nessy-agent/shared/pages'
import {
  PageActionRateLimiter,
  buildPageActionResultMessage,
  buildPageDataMessage,
  buildPageGrantsMessage,
  buildPageInitMessage,
  descriptorEquals,
  grantIdsEqual,
  isMutatingInvocation,
  parsePageBridgeMessage,
  reconcileGrantSummaries,
  toGrantSummary,
  type PageBridgeIncoming,
  type PageGrantSummary,
} from '../../../shared/page-bridge'
import { buildPageSrcdoc, PAGE_IFRAME_NAME } from '../../../shared/page-frame-csp'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  checkPageAction,
  checkPageGrantRequest,
  checkPageOpenUrl,
  descriptorSignature,
  isFromPageFrame,
  settlePageOpenUrl,
  type PendingGrantEntry,
} from './page-frame-gates'
import { PageGrantRequestDialog } from './PageGrantRequestDialog'

/**
 * The dedicated sandboxed Page renderer + trusted bridge host.
 *
 * Security posture (per the Pages design, §7; ours: spec §14, §15):
 * - `sandbox`: static pages get the empty set (no scripts at all);
 *   interactive/live get exactly `allow-scripts allow-forms`.
 *   NEVER `allow-same-origin` — scripts + same-origin would let page JS reach
 *   this document and the electronAPI adapter. The frame's origin is opaque.
 * - The srcDoc carries the content EXACTLY as returned by `pages:createLease`
 *   (the lease is bound to that content's digest) behind the builder's doctype,
 *   CSP and WebRTC prelude; the page bytes themselves are not altered.
 *   The lease nonce travels via postMessage `init` after load, and the page
 *   echoes it on every privileged request.
 * - Every incoming message must come from this frame's contentWindow with an
 *   opaque origin and parse against the strict schema in shared/page-bridge.
 * - Mutating actions (anything but an api GET) additionally require fresh user
 *   activation AND frame focus — the gesture was inside THIS frame.
 * - `open-url` needs the nonce, an http(s) URL, a live user gesture AND frame
 *   focus, and then the user's confirm of the full URL in this window.
 * - Grant requests never mint anything by themselves: they need a gesture inside
 *   the frame, the host validates each descriptor, and the approval dialog in
 *   THIS window is the user consent; `pages:issueGrant` binds the grant to the
 *   content digest on screen (and a script grant to the bytes it showed). One
 *   dialog at a time, a per-minute cap, and denied descriptors are remembered
 *   per render, so a page cannot re-prompt in a loop.
 * - Per-frame budget: bounded in-flight actions and a 30/minute window. The
 *   server-side PageActionBroker independently re-validates lease, nonce,
 *   replay, grant, and timeout — this component is the first gate, not the
 *   only one.
 */

interface PageFrameProps {
  workspaceId: string
  page: LoadedPage
  lease: PageRenderLease
  /** Exact content string returned with the lease (digest-bound) */
  content: string
  /**
   * Data snapshot handed to the page in `init`. Live pages also receive
   * replacement snapshots via `data` messages when this prop changes.
   */
  snapshot: PageDataSnapshot | null
  /** The page's grants as the host read them from the ledger (`pages:listGrants`, PageView). */
  grants: readonly PageActionGrant[]
  className?: string
}

function sandboxForKind(kind: PageKind): string {
  return kind === 'static' ? '' : 'allow-scripts allow-forms'
}

/**
 * The page's own canvas, not app chrome: authored pages (see the starter template in
 * resources/docs/pages.md) set dark text on an unset background, so the frame keeps a
 * white canvas in every theme and mode. The chrome around it (PageView) uses roles.
 */
// eslint-disable-next-line nessy-styles/no-raw-palette-colors -- page canvas, see above
const PAGE_CANVAS_CLASS = 'h-full w-full border-0 bg-white'

/** Transient user activation, propagated from clicks inside the frame. */
function hasUserActivation(): boolean {
  const nav = navigator as Navigator & { userActivation?: { isActive?: boolean } }
  return nav.userActivation?.isActive === true
}

export function PageFrame({ workspaceId, page, lease, content, snapshot, grants: ledgerGrants, className }: PageFrameProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const snapshotRef = useRef(snapshot)
  const limiterRef = useRef<PageActionRateLimiter | null>(null)
  if (!limiterRef.current) limiterRef.current = new PageActionRateLimiter()

  const pageSlug = page.config.slug
  const kind = page.config.kind
  const srcDoc = useMemo(() => buildPageSrcdoc(content, kind), [content, kind])

  // The link-out waiting for the user's confirm (OQ-12); one at a time.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const pendingUrlRef = useRef(pendingUrl)
  pendingUrlRef.current = pendingUrl

  // ------------------------------------------------------------------
  // Grants (usable = bound to the rendered digest and not expired).
  // Seeded from the ledger's grants at mount; grows via in-dialog approvals
  // and via re-reads (grants issued or revoked from another surface).
  // ------------------------------------------------------------------
  const usableLedgerGrants = useCallback((): PageGrantSummary[] => {
    const now = Date.now()
    return ledgerGrants
      .filter(g => isPageGrantUsable(g, lease.contentDigest, now))
      .map(toGrantSummary)
  }, [ledgerGrants, lease.contentDigest])

  // Nothing renders the summaries — the frame reads them from `init`/`grants` messages — so a ref is the state.
  const [initialGrants] = useState<PageGrantSummary[]>(usableLedgerGrants)
  const grantsRef = useRef<PageGrantSummary[]>(initialGrants)

  const [pendingRequest, setPendingRequest] = useState<PendingGrantEntry[] | null>(null)
  const [issueBusy, setIssueBusy] = useState(false)
  /** A grant request is being validated or shown — one at a time. */
  const grantDialogOpenRef = useRef(false)
  /** When this render's grant dialogs opened (the per-minute cap). */
  const grantDialogTimesRef = useRef<number[]>([])
  const deniedRef = useRef<Set<string>>(new Set())
  /** Approvals from this render the ledger re-read hasn't confirmed yet. */
  const locallyIssuedRef = useRef<Set<string>>(new Set())

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    // '*' is required: an opaque-origin frame cannot be addressed by origin.
    // The payload never contains credentials, and only THIS frame's window
    // object receives it.
    iframeRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const postInit = useCallback(() => {
    postToFrame(
      buildPageInitMessage({ slug: pageSlug, kind }, lease.nonce, snapshotRef.current, grantsRef.current),
    )
  }, [postToFrame, pageSlug, kind, lease.nonce])

  const postGrants = useCallback(
    (next: PageGrantSummary[]) => {
      grantsRef.current = next
      postToFrame(buildPageGrantsMessage(next))
    },
    [postToFrame],
  )

  // Reconcile against the ledger (the source of truth): grants issued from
  // other surfaces appear, revoked grants disappear — so page buttons disable
  // live. In-dialog approvals the re-read hasn't confirmed yet are kept via
  // locallyIssuedRef (reconcileGrantSummaries releases them on confirmation).
  useEffect(() => {
    const next = reconcileGrantSummaries(grantsRef.current, usableLedgerGrants(), locallyIssuedRef.current)
    if (!grantIdsEqual(next, grantsRef.current)) {
      postGrants(next)
    }
  }, [usableLedgerGrants, postGrants])

  // Live pages get replacement snapshots; interactive pages keep their
  // init-time snapshot (per the kind contract).
  useEffect(() => {
    const changed = snapshotRef.current !== snapshot
    snapshotRef.current = snapshot
    if (changed && kind === 'live') {
      postToFrame(buildPageDataMessage(snapshot))
    }
  }, [snapshot, kind, postToFrame])

  const frameFocused = useCallback((): boolean => {
    const frame = iframeRef.current
    return frame !== null && document.activeElement === frame
  }, [])

  const handleAction = useCallback(
    async (msg: Extract<PageBridgeIncoming, { type: 'action' }>) => {
      const limiter = limiterRef.current!
      const reject = (error: string) =>
        postToFrame(
          buildPageActionResultMessage({ requestId: msg.requestId, ok: false, error, durationMs: 0 }),
        )

      const mutating = isMutatingInvocation(msg.invocation)
      const gate = checkPageAction({
        nonce: msg.nonce,
        leaseNonce: lease.nonce,
        mutating,
        userActivation: hasUserActivation(),
        frameFocused: frameFocused(),
      })
      if (!gate.ok) {
        reject(gate.error)
        // UA12.112 — the refusal was decided HERE, before the broker: report it so the audit trail
        // carries it (`page_action_rejected`, stage 'renderer-gate'). Fire-and-forget: an audit
        // failure never changes the refusal.
        void window.electronAPI.auditPageGateRefusal(workspaceId, {
          kind: 'action',
          pageSlug,
          code: gate.reason,
          reason: gate.error,
          requestId: msg.requestId,
          leaseId: lease.leaseId,
          grantId: msg.grantId,
          invocation: msg.invocation,
        }).catch(() => {})
        return
      }
      const limited = limiter.canStart(Date.now(), mutating)
      if (limited) {
        reject(`${limited}: too many page actions in flight`)
        return
      }

      limiter.start(msg.requestId, Date.now(), mutating)
      try {
        const request: PageActionRequest = {
          requestId: msg.requestId,
          pageSlug,
          leaseId: lease.leaseId,
          nonce: msg.nonce,
          grantId: msg.grantId,
          invocation: msg.invocation,
        }
        const result: PageActionResult = await window.electronAPI.executePageAction(workspaceId, request)
        postToFrame(buildPageActionResultMessage(result))
      } catch (err) {
        reject(err instanceof Error ? err.message : 'Action failed')
      } finally {
        limiter.finish(msg.requestId)
      }
    },
    [workspaceId, pageSlug, lease.leaseId, lease.nonce, postToFrame, frameFocused],
  )

  const handleGrantRequest = useCallback(
    async (msg: Extract<PageBridgeIncoming, { type: 'grant-request' }>) => {
      const current = grantsRef.current
      const gate = checkPageGrantRequest({
        nonce: msg.nonce,
        leaseNonce: lease.nonce,
        userActivation: hasUserActivation(),
        frameFocused: frameFocused(),
        dialogOpen: grantDialogOpenRef.current,
        recentDialogs: grantDialogTimesRef.current,
        now: Date.now(),
      })
      if (!gate.ok) {
        // UA12.112 — the refusal was decided HERE: report it for the audit (`page_grant_request_refused`,
        // stage 'renderer-gate'), whatever the answer to the page is below. Fire-and-forget.
        void window.electronAPI.auditPageGateRefusal(workspaceId, {
          kind: 'grant-request',
          pageSlug,
          code: gate.reason,
          requestCount: msg.requests.length,
        }).catch(() => {})
        // A wrong nonce gets nothing; any other refusal answers with the current state — the page reconciles by descriptor.
        if (gate.reason !== 'nonce-mismatch') postToFrame(buildPageGrantsMessage(current))
        return
      }
      const remaining = msg.requests.filter(
        req =>
          !current.some(g => descriptorEquals(g.action, req.action)) &&
          !deniedRef.current.has(descriptorSignature(req.action)),
      )
      // Nothing new to ask (all satisfied or already denied this render).
      if (remaining.length === 0) {
        postToFrame(buildPageGrantsMessage(current))
        return
      }
      grantDialogOpenRef.current = true
      grantDialogTimesRef.current = [...grantDialogTimesRef.current.filter(at => Date.now() - at < 60_000), Date.now()]
      // The HOST validates each descriptor and, for a script, reads the sha256 of its bytes now; the dialog shows that.
      const validated: PendingGrantEntry[] = []
      for (const entry of remaining) {
        try {
          const described = await window.electronAPI.describePageGrantRequest(workspaceId, pageSlug, entry.action)
          validated.push({
            key: entry.key,
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            action: described.action,
            ...(described.scriptSha256 ? { scriptSha256: described.scriptSha256 } : {}),
          })
        } catch {
          // The host refused the descriptor (an unknown shape, a script outside the workspace or missing): not shown.
        }
      }
      if (validated.length === 0) {
        grantDialogOpenRef.current = false
        postToFrame(buildPageGrantsMessage(grantsRef.current))
        return
      }
      setPendingRequest(validated)
    },
    [workspaceId, pageSlug, lease.nonce, postToFrame, frameFocused],
  )

  const closeGrantDialog = useCallback(() => {
    grantDialogOpenRef.current = false
    setPendingRequest(null)
  }, [])

  const handleApprove = useCallback(async () => {
    if (!pendingRequest) return
    setIssueBusy(true)
    const issued: PageGrantSummary[] = []
    let failed = false
    for (const entry of pendingRequest) {
      try {
        const grant = await window.electronAPI.issuePageGrant(workspaceId, pageSlug, {
          action: entry.action,
          contentDigest: lease.contentDigest,
          ...(entry.scriptSha256 ? { scriptSha256: entry.scriptSha256 } : {}),
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        })
        issued.push(toGrantSummary(grant))
        locallyIssuedRef.current.add(grant.id)
      } catch (err) {
        failed = true
        toast.error(t('toast.pageGrantFailed'), {
          description: err instanceof Error ? err.message : String(err),
        })
        break
      }
    }
    if (issued.length > 0 && !failed) {
      toast.success(t('toast.pageGrantsIssued'))
    }
    postGrants([...grantsRef.current, ...issued])
    closeGrantDialog()
    setIssueBusy(false)
  }, [pendingRequest, workspaceId, pageSlug, lease.contentDigest, postGrants, closeGrantDialog, t])

  const handleDeny = useCallback(() => {
    if (pendingRequest) {
      for (const entry of pendingRequest) {
        deniedRef.current.add(descriptorSignature(entry.action))
      }
    }
    closeGrantDialog()
    postGrants(grantsRef.current)
  }, [pendingRequest, postGrants, closeGrantDialog])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frame = iframeRef.current
      if (!isFromPageFrame(event, frame?.contentWindow)) return
      const msg = parsePageBridgeMessage(event.data)
      if (!msg) return

      switch (msg.type) {
        case 'ready':
          postInit()
          break
        case 'action':
          void handleAction(msg)
          break
        case 'action-cancel':
          if (msg.nonce === lease.nonce) {
            void window.electronAPI.cancelPageAction(workspaceId, msg.requestId)
          }
          break
        case 'open-url': {
          // Only real link-outs: correct nonce, http(s), a live user gesture inside
          // THIS frame (it holds focus), and then the user's confirm of the full URL.
          const decision = checkPageOpenUrl({
            nonce: msg.nonce,
            url: msg.url,
            leaseNonce: lease.nonce,
            userActivation: hasUserActivation(),
            frameFocused: frame !== null && document.activeElement === frame,
            confirmationPending: pendingUrlRef.current !== null,
          })
          if (decision.ok) setPendingUrl(decision.url)
          break
        }
        case 'grant-request':
          void handleGrantRequest(msg)
          break
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleAction, handleGrantRequest, postInit, lease.nonce, workspaceId])

  // Abort anything still in flight when the render goes away; the lease
  // release (PageView) invalidates the rest server-side.
  useEffect(() => {
    const limiter = limiterRef.current!
    return () => {
      for (const requestId of limiter.inFlightIds) {
        void window.electronAPI.cancelPageAction(workspaceId, requestId)
      }
    }
  }, [workspaceId])

  // The side effect stays outside any state updater: StrictMode's dev double render runs an
  // updater twice and would open the link twice. Clearing the ref first makes a second click
  // before the re-render a no-op.
  const settle = useCallback((decision: 'confirm' | 'cancel') => {
    const pending = pendingUrlRef.current
    pendingUrlRef.current = null
    setPendingUrl(null)
    settlePageOpenUrl(pending, decision, url => {
      void window.electronAPI.openUrl(url)
    })
  }, [])

  return (
    <>
      <iframe
        ref={iframeRef}
        title={page.config.name}
        sandbox={sandboxForKind(kind)}
        name={PAGE_IFRAME_NAME}
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        onLoad={postInit}
        className={className ?? PAGE_CANVAS_CLASS}
      />
      <Dialog open={pendingUrl !== null} onOpenChange={open => !open && settle('cancel')}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('pages.openUrlConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('pages.openUrlConfirmDescription', { name: page.config.name })}
            </DialogDescription>
          </DialogHeader>
          <PageOpenUrlTarget url={pendingUrl ?? ''} />
          {/* UB14.39 (R6-10) — v0.15.1's dialog vocabulary: Cancel ghost, the forward Open primary, no footer gap override. */}
          <DialogFooter>
            <Button variant="ghost" onClick={() => settle('cancel')}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => settle('confirm')}>
              {t('common.openLink')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PageGrantRequestDialog
        pageName={page.config.name}
        requests={pendingRequest}
        busy={issueBusy}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </>
  )
}

/**
 * The full URL a link-out confirmation shows: never truncated, wrapped at any character. UB14.39: in v0.15.1's sunken
 * well with the mono role and secondary text.
 */
export function PageOpenUrlTarget({ url }: { url: string }) {
  return (
    <code className="block max-h-40 overflow-y-auto break-all rounded-md bg-sunken px-2.5 py-2 text-mono-ui text-secondary select-text">
      {url}
    </code>
  )
}
