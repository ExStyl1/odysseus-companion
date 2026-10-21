/**
 * renderHook over the REAL react-dom reconciler (UB14.46), for hooks whose behaviour lives in
 * effects and timers.
 *
 * The repo has no DOM or renderHook library (see `useBackgroundTasks.test.ts`), and the usual way
 * round it — exporting the load-bearing decision as a pure function — would fork a hook taken 1:1
 * from v0.15.1 away from its source. So the hook runs unmodified inside a probe component that
 * renders no host element, and only what react-dom touches for such a tree is stubbed:
 *  - the container is a bare object carrying the members `createRoot` and the root host context
 *    read (`nodeType`, `tagName`, `namespaceURI`, the add/removeEventListener pair its root
 *    listeners call, a null `ownerDocument`);
 *  - react-dom's commit phase reads the free global `window` (`getActiveElementDeep` compares the
 *    focused element with `instanceof window.HTMLIFrameElement`), so a one-member stub is installed
 *    while a hook is mounted and removed on unmount when this harness installed it;
 *  - every render, re-render and timer advance runs inside `React.act`, so updates and passive
 *    effects are flushed before the call returns.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'

export interface RenderedHook<P, R> {
  /** The hook's value at the last render. */
  readonly current: R
  /** Every rendered value in order, so a value that appeared and went again is still visible. */
  readonly history: readonly R[]
  /** Render again with new props. */
  rerender(props: P): void
  /** Run `fn` (a fake-timer advance, say) inside act, so the updates it causes are flushed. */
  act(fn: () => void): void
  unmount(): void
}

/** The two globals this harness sets, typed apart from the DOM lib's `window` declaration. */
type HarnessGlobals = { IS_REACT_ACT_ENVIRONMENT?: boolean; window?: unknown }

export function renderHook<P, R>(hook: (props: P) => R, initialProps: P): RenderedHook<P, R> {
  const g = globalThis as unknown as HarnessGlobals
  const installedWindow = typeof g.window === 'undefined'
  if (installedWindow) g.window = { HTMLIFrameElement: class {} }
  const previousActEnvironment = g.IS_REACT_ACT_ENVIRONMENT
  g.IS_REACT_ACT_ENVIRONMENT = true

  const container = {
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: null,
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
  }
  const history: R[] = []
  let current!: R

  function Probe({ props }: { props: P }): null {
    current = hook(props)
    history.push(current)
    return null
  }

  const root = createRoot(container as unknown as Element)
  const act = (fn: () => void) => {
    React.act(() => {
      fn()
    })
  }
  act(() => root.render(React.createElement(Probe, { props: initialProps })))

  return {
    get current() {
      return current
    },
    history,
    rerender(props: P) {
      act(() => root.render(React.createElement(Probe, { props })))
    },
    act,
    unmount() {
      act(() => root.unmount())
      g.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      if (installedWindow) delete g.window
    },
  }
}
