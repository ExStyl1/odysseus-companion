/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/chat-display/strip-repeated-title.ts (UB14.14; ADDED in v0.15.0).
 */
/**
 * Body text without a leading copy of the title ("Authentication Failed: Unable to …" under
 * the title "Authentication Failed"), so the title reads once (spec §7.7). Same data, shown once.
 */
export function stripRepeatedTitle(title: string, body: string): string {
  const trimmedTitle = title.trim()
  const trimmedBody = body.trim()
  if (!trimmedTitle || !trimmedBody.toLowerCase().startsWith(trimmedTitle.toLowerCase())) return body
  const rest = trimmedBody.slice(trimmedTitle.length)
  // Only "Title: message" (how titled errors are built) or the bare title counts — "Error rate
  // limit exceeded" / "Error-prone config" under the fallback title "Error" are sentences.
  if (rest && !/^\s*:/.test(rest)) return body
  return rest.replace(/^\s*:\s*/, '')
}
