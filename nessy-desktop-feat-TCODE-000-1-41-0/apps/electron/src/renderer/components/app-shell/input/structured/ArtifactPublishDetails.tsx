/**
 * UA1.18 — the host-gate variant of the permission card for `publish_artifact`: everything the person needs to
 * decide whether these bytes may leave the machine, rendered from `request.artifactPublish` (built by the host from
 * the publish guard's ONE buffer). Mounted by `PermissionRequest.tsx` when that payload is present; the answer rides
 * the card's own Allow/Deny (the host sends `noAlwaysAllow`, so nothing can be remembered).
 *
 * The preview never runs the page: HTML goes into a frame with `sandbox=""` and a deny-all CSP
 * (`artifactPreviewSrcDoc`), and Markdown is rendered by the app's own renderer, loaded lazily so this card stays
 * importable where that renderer's module graph cannot load (the `turn-preview.ts` note).
 *
 * UB14.25 — restyled in the decision anatomy's vocabulary (v0.15.1 `structured/DecisionCard.tsx`, UB14.20): the
 * access line is the toned block the permission card keeps for its impact, the facts are label-size secondary
 * text, the preview and the first source lines sit in the sunken wells. Restyle only: every line, its key and its
 * `data-testid` are unchanged, and the same markup serves the page share dialog.
 *
 * UB12.84 — that block's tone is v0.15.1's amber "needs you" role (the info tint, the info inset hairline and the
 * solved `text-info` ink, as on the impact block). It spelled `border-warning/30 bg-warning/10 text-warning` until
 * then, which drew nothing: tokens.css defines no warning colour. The line gained `data-testid="artifact-publish-access"`
 * so `PermissionImpact.test.tsx` can check its colour classes against tokens.css' own names.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import {
  artifactExpiryLabel,
  artifactPreviewSrcDoc,
  artifactShaPrefix,
  artifactUpdateDiff,
  chatShareSummary,
  type ArtifactPublishCardData,
} from './artifact-publish-card'

const LazyMarkdown = React.lazy(() => import('@nessy-agent/ui').then(module => ({ default: module.Markdown })))

export function ArtifactPublishDetails({ card }: { card: ArtifactPublishCardData }) {
  const { t, i18n } = useTranslation()
  const expiry = artifactExpiryLabel(card.expiresAt, i18n.language)
  const diff = artifactUpdateDiff(card)
  const keptExpiry = card.mode === 'update' && card.retentionDays === undefined
  // UA1.26 — a chat share names what the snapshot did instead of a file line.
  const chat = chatShareSummary(card)

  return (
    <div className="space-y-2.5 text-label" data-testid="artifact-publish-details">
      <div
        className="flex items-start gap-1.5 rounded-md bg-info-tint px-2.5 py-2 text-info inset-ring inset-ring-[var(--info-border)] [&_svg]:size-3.5 [&_svg]:shrink-0"
        data-testid="artifact-publish-access"
      >
        <TriangleAlert className="mt-[2px]" />
        <span className="min-w-0">{t('chat.artifactPublish.access')}</span>
      </div>

      <div className="space-y-0.5 text-secondary">
        <div className="font-medium text-foreground">{card.emoji} {card.title}</div>
        {/* UA12.27 — the owner line names the LAST KNOWN dp login (the cached Nessy Gateway credential's, P-UA-n-4); a live
            dp print-token signs the publish, so the copy says "last known as". No usable cached credential: the unnamed line. */}
        <div>
          {card.ownerLogin !== undefined
            ? t('chat.artifactPublish.ownerNamed', { login: card.ownerLogin })
            : t('chat.artifactPublish.owner')}
        </div>
        <div data-testid="artifact-publish-expiry">
          {card.expiresUnknown === true
            ? t('chat.artifactPublish.expiresUnknown')
            : expiry === null
              ? t('chat.artifactPublish.expiresNever')
              : keptExpiry
                ? t('chat.artifactPublish.expiresKept', { date: expiry })
                : t('chat.artifactPublish.expires', { date: expiry })}
        </div>
        {card.url && (
          <div className="break-all">{t('chat.artifactPublish.link', { url: card.url })}</div>
        )}
        {chat ? (
          <div data-testid="artifact-publish-chat">
            <div>{t('chat.artifactPublish.chatContent')}</div>
            <div>
              {chat.maskedTotal > 0
                ? t('chat.artifactPublish.chatMasked', { n: chat.maskedTotal, rules: chat.maskedRules })
                : t('chat.artifactPublish.chatMaskedNone')}
            </div>
            <div>{t('chat.artifactPublish.chatPaths', { n: chat.relativisedPaths })}</div>
            {chat.truncatedPayloads > 0 && (
              <div>{t('chat.artifactPublish.chatTruncated', { n: chat.truncatedPayloads })}</div>
            )}
          </div>
        ) : (
          <div className="break-all">{t('chat.artifactPublish.file', { path: card.sourcePath })}</div>
        )}
        <div>
          {t('chat.artifactPublish.size', {
            bytes: card.byteLength,
            lines: card.lineCount,
            sha: artifactShaPrefix(card.sha256),
          })}
        </div>
        {diff && (
          <div data-testid="artifact-publish-diff">
            {diff.kind === 'unchanged'
              ? t('chat.artifactPublish.diffUnchanged')
              : diff.kind === 'sized'
                ? t('chat.artifactPublish.diffSized', { bytes: diff.byteDelta, lines: diff.lineDelta })
                : t('chat.artifactPublish.diffUnknown')}
          </div>
        )}
        <div>{t('chat.artifactPublish.scripts', { count: card.scriptCount })}</div>
        <div className="break-all" data-testid="artifact-publish-hosts">
          {card.externalHosts.length > 0
            ? t('chat.artifactPublish.externalHosts', { hosts: card.externalHosts.join(', ') })
            : t('chat.artifactPublish.externalHostsNone')}
        </div>
        <div>
          {t('chat.artifactPublish.scanSentence')}{' '}
          {t('chat.artifactPublish.scanCounts', { emails: card.emailCount, phones: card.phoneCount })}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-label-sm font-medium text-tertiary">{t('chat.artifactPublish.preview')}</div>
        {card.contentType === 'html' ? (
          <iframe
            title={t('chat.artifactPublish.preview')}
            sandbox=""
            srcDoc={artifactPreviewSrcDoc(card.previewContent)}
            className="h-48 w-full rounded-md bg-white ring-1 ring-separator"
            data-testid="artifact-publish-frame"
          />
        ) : (
          <div className="max-h-48 overflow-y-auto rounded-md bg-sunken px-2.5 py-2 ring-1 ring-inset ring-separator" data-testid="artifact-publish-markdown">
            <React.Suspense fallback={<pre className="whitespace-pre-wrap break-all font-mono">{card.previewContent}</pre>}>
              <LazyMarkdown mode="minimal">{card.previewContent}</LazyMarkdown>
            </React.Suspense>
          </div>
        )}
        {card.previewTruncated && (
          <div className="text-label-sm text-tertiary">{t('chat.artifactPublish.previewTruncated')}</div>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-label-sm font-medium text-tertiary">{t('chat.artifactPublish.source')}</div>
        <pre
          className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-sunken px-2.5 py-2 font-mono text-mono-ui text-secondary ring-1 ring-inset ring-separator"
          data-testid="artifact-publish-source"
        >
          {card.sourceHead}
        </pre>
      </div>
    </div>
  )
}
