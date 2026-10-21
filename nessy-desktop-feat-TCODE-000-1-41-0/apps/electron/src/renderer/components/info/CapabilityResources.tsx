import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EditButton, EditPopover } from '@/components/ui/EditPopover'
import { Info_Markdown } from './Info_Markdown'
import type {
  MutableCapabilityManagedResourceRef,
  PreviewableCapabilityManagedResourceRef,
  ManagedEditContextKey,
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
} from '@nessy-agent/shared/protocol/capabilities'

export function CapabilityResources({ context, detail }: {
  context: SafeCapabilityContextRef
  detail: SafeCapabilityDetail
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = React.useState<{ key: string; title: string; content: string } | null>(null)

  return (
    <div className="divide-y divide-separator">
      {detail.resources.map((resource) => {
        const key = JSON.stringify(resource.ref)
        const label = `${resource.ref.scope} / ${resource.ref.file}`
        const mutable = mutableResource(resource.ref)
        const previewable = previewableResource(resource.ref)
        return (
          <div key={key} className="space-y-3 px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-label text-foreground [overflow-wrap:anywhere]">{label}</span>
              <div className="flex shrink-0 items-center gap-2">
                {resource.canPreview && previewable && (
                  <Button variant="ghost" size="sm" onClick={async () => {
                    const next = await window.electronAPI.capabilities.preview(context, previewable)
                    setPreview({ key, title: next.title, content: next.content })
                  }}>
                    {t('common.open')}
                  </Button>
                )}
                {resource.canOpen && mutable && (
                  <Button variant="ghost" size="sm" onClick={() => window.electronAPI.capabilities.open(context, mutable)}>
                    {t('common.editFile')}
                  </Button>
                )}
                {resource.canEdit && mutable && (
                  <EditPopover
                    trigger={<EditButton />}
                    managedResource={{ resource: mutable, contextKey: editContextKey(mutable), label }}
                    displayLabel={label}
                    inlineExecution
                  />
                )}
              </div>
            </div>
            {preview?.key === key && <Info_Markdown fullscreen>{preview.content}</Info_Markdown>}
          </div>
        )
      })}
    </div>
  )
}

function editContextKey(ref: MutableCapabilityManagedResourceRef): ManagedEditContextKey {
  if (ref.scope === 'source') {
    return ref.file === 'config'
      ? 'source-config'
      : ref.file === 'guide'
        ? 'source-guide'
        : 'source-permissions'
  }
  return ref.file === 'manifest' ? 'skill-metadata' : 'skill-instructions'
}

function mutableResource(ref: SafeCapabilityDetail['resources'][number]['ref']): MutableCapabilityManagedResourceRef | null {
  if (ref.scope === 'skill' && ref.tier === 'plugin') return null
  return ref
}

function previewableResource(ref: SafeCapabilityDetail['resources'][number]['ref']): PreviewableCapabilityManagedResourceRef | null {
  return isPreviewableResource(ref) ? ref : null
}

function isPreviewableResource(
  ref: SafeCapabilityDetail['resources'][number]['ref'],
): ref is PreviewableCapabilityManagedResourceRef {
  return ref.scope !== 'source' || ref.file !== 'config'
}
