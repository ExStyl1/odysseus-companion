import { describe, expect, it } from 'bun:test'
import { resolveStagedImagePolicy } from '../attachment-capability'

describe('resolveStagedImagePolicy', () => {
  it('blocks the send when the runtime declares it takes no images', () => {
    expect(resolveStagedImagePolicy({
      hasStagedImages: true,
      images: 'no',
      providerType: 'codex-runtime',
    })).toEqual({ blocked: true, offerModelOverride: false })
  })

  // P3.136. `claude-runtime` used to be the subject of the case above, on the
  // premise that its adapter dropped image parts whatever the catalog said —
  // untrue since `30628c7d0`, and while it stood the runtime's own
  // `supportsImages` declaration had no UI writer anywhere in the product.
  // `codex-runtime` takes that seat because there the premise is still true:
  // its images ride codex's own wire, not a catalog declaration this button
  // writes.
  it('offers the per-model override on every runtime whose catalog decides the send', () => {
    for (const providerType of ['pi_compat', 'claude-runtime'] as const) {
      expect(resolveStagedImagePolicy({
        hasStagedImages: true,
        images: 'no',
        providerType,
      })).toEqual({ blocked: true, offerModelOverride: true })
    }
  })

  // The negative subject. `images: 'no'` is the ONLY blocking value: a
  // composer that has not heard from the server yet reads `'per-model'`
  // (DEFAULT_COMPOSER_CAPABILITIES) and must fail open rather than refuse
  // every image send until the first capabilities event arrives.
  it('does not block on an unresolved or image-capable runtime', () => {
    for (const images of ['yes', 'per-model'] as const) {
      expect(resolveStagedImagePolicy({
        hasStagedImages: true,
        images,
        providerType: 'pi_compat',
      })).toEqual({ blocked: false, offerModelOverride: false })
    }
  })

  it('does nothing when nothing is staged', () => {
    expect(resolveStagedImagePolicy({
      hasStagedImages: false,
      images: 'no',
      providerType: 'pi_compat',
    })).toEqual({ blocked: false, offerModelOverride: false })
  })
})
