/* Copied from v0.15.1:apps/electron/src/renderer/components/app-shell/fit-labels.ts (craft-agents-oss, Apache-2.0) by
   UB14.3, 2026-10-16 (added in v0.15.1: the session row's "+N" label fit). */
/** Number of whole, ordered chips that fit, reserving a counter when any are hidden. */
export function fitLabelCount(widths: readonly number[], available: number, counterWidth: number, gap = 4): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
  if (total <= available) return widths.length
  let used = 0
  let count = 0
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width
    if (next + gap + counterWidth > available) break
    used = next
    count++
  }
  return count
}
