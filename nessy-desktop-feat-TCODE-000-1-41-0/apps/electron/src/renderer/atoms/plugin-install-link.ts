import { atom } from 'jotai'

/**
 * P6.512 — the parcel an `install-plugin` deep link leaves for the Plugins page.
 *
 * WHY AN ATOM AND NOT A ROUTE PARAM. A view route in this app carries no
 * parameters (`parseRoute` returns `params: {}` for every `type: 'view'`), so
 * teaching `route-parser.ts` a query string for one link would change a shared
 * grammar every navigator reads. This is one value, handed over once, and it
 * costs one module.
 *
 * WHY THE RAW TEXT AND NOT A RESOLVED TARGET. `resolveInstallPluginLink` decides
 * against the marketplaces this machine has ALREADY REGISTERED, and that list
 * lives in the Plugins page's own query — not in the navigation context. Parking
 * the link's own two fields and resolving them where the registered set is known
 * keeps the single gate single; resolving early with an empty list would refuse
 * every link that names a marketplace.
 *
 * So the strings below are UNTRUSTED until `resolveInstallPluginLink` has passed
 * them. Nothing reads them for any other purpose, and consuming the parcel
 * clears it (`null`) so a second visit to the page does not re-apply a link the
 * user has already seen.
 */
export interface PendingPluginInstallLink {
  /** The link's own id segment: `plugin` or the documented `plugin@marketplace`. */
  id: string
  /** The link's `marketplace` query parameter, when it carried one. */
  marketplace?: string
}

/** `null` whenever no install link is waiting to be applied. */
export const pendingPluginInstallAtom = atom<PendingPluginInstallLink | null>(null)
