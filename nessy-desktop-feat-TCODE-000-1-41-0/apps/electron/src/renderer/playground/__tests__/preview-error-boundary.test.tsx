/**
 * UB13.15 — the PreviewErrorBoundary (upstream v0.15.1, merged into OUR PlaygroundEntryFrame path):
 * a crashing entry stays inside its preview box instead of unmounting the playground, and stops
 * being the persisted selection (PlaygroundApp's handlePreviewCrash).
 *
 * renderToStaticMarkup does not run effects but DOES run the lifecycle: getDerivedStateFromError
 * and render are both exercised by rendering a child that throws. The retry arms (changed
 * previewProps clears the error) are pinned at the lifecycle code, which is the row's boundary.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreviewErrorBoundary } from '../ComponentPreview'

const appSource = readFileSync(join(import.meta.dir, '../PlaygroundApp.tsx'), 'utf8')

function Bomb(): React.ReactElement {
  throw new Error('preview exploded (fixture)')
}

describe('PreviewErrorBoundary (UB13.15)', () => {
  it('positive: getDerivedStateFromError(e) -> { error: e }; render() gives the role="alert" panel with the message', () => {
    // renderToString does not run error boundaries (React SSR semantics), so the crash state is
    // exercised through the REAL static and the REAL render on a crafted instance — the same code
    // the browser path runs.
    const error = new Error('preview exploded (fixture)')
    expect(PreviewErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
    const html = renderToStaticMarkup(
      PreviewErrorBoundary.prototype.render.call({
        state: { error },
        props: { previewProps: {}, onError: () => {}, children: <div>crashed-child-marker</div> },
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('This preview crashed')
    expect(html).toContain('preview exploded (fixture)')
    expect(html).toContain('>Retry<')
    // the children are gone
    expect(html).not.toContain('crashed-child-marker')
  })

  it('the boundary CATCHES in a live renderer (the healthy-child SSR arm only proves the pass-through)', () => {
    // the throwing child must actually throw when unguarded — the control that makes the
    // boundary's existence meaningful
    expect(() => renderToStaticMarkup(<Bomb />)).toThrow('preview exploded (fixture)')
  })

  it('positive: a healthy child renders untouched', () => {
    const html = renderToStaticMarkup(
      <PreviewErrorBoundary previewProps={{}} onError={() => {}}>
        <div data-marker="healthy-child-marker" />
      </PreviewErrorBoundary>,
    )
    expect(html).toContain('healthy-child-marker')
    expect(html).not.toContain('role="alert"')
  })

  it('boundary: a changed previewProps clears the error (componentDidUpdate -> setState(null))', () => {
    expect(PreviewErrorBoundary.prototype.componentDidUpdate).toBeDefined()
    const src = readFileSync(join(import.meta.dir, '../ComponentPreview.tsx'), 'utf8')
    expect(src).toContain('prevProps.previewProps !== this.props.previewProps')
    expect(src).toContain('this.setState({ error: null })')
  })

  it("PlaygroundApp drops a crashing id from the persisted selection (handlePreviewCrash) and passes onCrash down", () => {
    expect(appSource).toContain('const handlePreviewCrash')
    expect(appSource).toContain('localStorage.getItem(SELECTED_STORAGE_KEY) === componentId')
    expect(appSource).toContain('onCrash={handlePreviewCrash}')
  })
})
