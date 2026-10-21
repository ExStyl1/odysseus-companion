/**
 * Source: v0.15.1:apps/electron/src/renderer/components/automations/ActionTypeIcon.tsx (UB14.44; the
 * restyle taken, our UA8.3 `script` arm re-applied). Apache-2.0, LICENSE and NOTICE kept.
 */
import { MessageSquare, SquareTerminal, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ActionTypeIcon({ type, className }: { type: 'prompt' | 'webhook' | 'script'; className?: string }) {
  const Icon = type === 'webhook' ? Webhook : type === 'script' ? SquareTerminal : MessageSquare // UA8.3: script
  return <Icon className={cn('text-tertiary', className)} aria-hidden />
}
