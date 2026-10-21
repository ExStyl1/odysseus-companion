/**
 * UA6.7 — the Share dialog's DECISIONS as values (the `artifact-publish-card.ts` convention: a decision does not live
 * in a component a test can only read as source). Upstream v0.13.4 `SharePageDialog.tsx` makes the same decisions
 * inline (Apache-2.0); ours read the page's publication from `LoadedPage.publication` (the artifact registry, never
 * page.json) and the grants from the host-approvals ledger (`pages:listGrants`, never `config.grants`).
 */
import type { LoadedPage, PageActionGrant } from '@nessy-agent/shared/pages'
import { isPageGrantUsable } from '@nessy-agent/shared/pages/types'

export interface SharePageState {
  /** A live copy exists (the dialog shows its link, republish and unpublish). */
  published: boolean
  /**
   * An earlier copy's deletion failed and is retried after the next sign-in (UA1.19). The page is private as far as
   * this workspace is concerned and may be published again (a new link); the old one leaves on the retry.
   */
  deletionPending: boolean
  /** Script approvals refuse publishing outright, even stale ones (upstream's rule). */
  scriptGrants: PageActionGrant[]
  /** Usable non-script approvals: the person must acknowledge the copy is view-only. */
  needsViewOnlyAck: boolean
  /** The local page changed since the last publish (upstream's "update available"). */
  contentDrifted: boolean
  /** The data toggle is offered: a snapshot exists and the page runs scripts (a static page cannot read data). */
  offerIncludeData: boolean
}

export function sharePageState(page: LoadedPage, grants: readonly PageActionGrant[], hasSnapshot: boolean, now = Date.now()): SharePageState {
  const publication = page.publication
  const scriptGrants = grants.filter(grant => grant.action.kind === 'script')
  return {
    published: publication !== undefined && publication.pendingDelete !== true,
    deletionPending: publication?.pendingDelete === true,
    scriptGrants,
    needsViewOnlyAck: grants.some(grant => grant.action.kind !== 'script' && isPageGrantUsable(grant, page.config.contentDigest, now)),
    contentDrifted: Boolean(
      publication && !publication.pendingDelete && page.config.contentDigest
      && publication.pageContentDigest !== page.config.contentDigest,
    ),
    offerIncludeData: hasSnapshot && page.config.kind !== 'static',
  }
}

/** Whether the Publish button may be pressed: never with a script approval, never without the ack it needs. */
export function sharePublishBlocked(state: SharePageState, acknowledged: boolean): boolean {
  return state.scriptGrants.length > 0 || (state.needsViewOnlyAck && !acknowledged)
}

/** The first three secret-looking key paths and a "+N" for the rest (upstream's preview). */
export function secretKeysPreview(candidates: readonly string[]): string {
  return candidates.slice(0, 3).join(', ') + (candidates.length > 3 ? ` +${candidates.length - 3}` : '')
}
