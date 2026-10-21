/**
 * The class list behind the app's small square icon buttons — the session
 * panel's own close and share controls, and anything that should read as the
 * SAME control rather than merely doing the same thing.
 *
 * It lives in its own module, free of React and of the `@nessy-agent/ui`
 * barrel, for one measured reason: `PanelHeaderCenterButton.tsx` imports that
 * barrel, and a component test that pulls the barrel in loads the whole UI
 * package — including a pdf worker whose `?url` import has no default export
 * under the test runner. `PendingAuthNotice`'s suite went 12 pass → 1 error the
 * moment the component was imported for its styling alone.
 *
 * So a caller that wants the LOOK imports this; a caller that wants the button
 * (tooltip, ref forwarding) imports the component. Both read from here, so the
 * two cannot drift apart.
 */
export const PANEL_HEADER_BUTTON_CLASS = [
  // UB14.6 — v0.15.1 `ui/PanelHeaderCenterButton.tsx`'s classes, taken 1:1: a 28×28 ghost button with a secondary
  // icon (spec §7.3) instead of the raised white chip; in the compact shell `.panel-header-btn` grows it to a 44px
  // touch target (`index.css`). Focus is the app-wide `:focus-visible` ring, as upstream.
  'panel-header-btn inline-flex items-center justify-center',
  'size-control shrink-0 rounded-md titlebar-no-drag',
  'text-secondary hover:text-foreground hover:bg-fill-hover active:bg-fill-pressed',
  'data-[state=open]:text-foreground data-[state=open]:bg-fill-hover',
  'transition-[background-color,color] duration-micro ease-out-subtle hover:duration-instant',
  'disabled:pointer-events-none disabled:text-disabled',
].join(' ')
