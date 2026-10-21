import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface AddWorkspaceStep_CreateNewProps {
  onBack: () => void
  onCreate: (name: string) => Promise<void>
  isCreating: boolean
}

export function AddWorkspaceStep_CreateNew({
  onBack,
  onCreate,
  isCreating,
}: AddWorkspaceStep_CreateNewProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return
    await onCreate(name.trim())
  }, [name, onCreate])

  return (
    <AddWorkspaceContainer>
      <button
        onClick={onBack}
        disabled={isCreating}
        className={cn(
          'self-start flex items-center gap-1 text-sm text-muted-foreground',
          'hover:text-foreground transition-colors mb-4',
          isCreating && 'opacity-50 cursor-not-allowed',
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        {t('common.back')}
      </button>

      <AddWorkspaceStepHeader
        title={t('workspace.createWorkspace')}
        description={t('workspace.createWorkspaceDesc')}
      />

      <div className="mt-6 w-full space-y-6">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground mb-2.5">
            {t('workspace.nameLabel')}
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('workspace.myWorkspace')}
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        <AddWorkspacePrimaryButton
          onClick={handleCreate}
          disabled={!name.trim() || isCreating}
          loading={isCreating}
          loadingText={t('workspace.creating')}
        >
          {t('common.create')}
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}
