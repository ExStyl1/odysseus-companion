import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle, Plus, XCircle } from 'lucide-react'
import type {
  ConnectRemoteWorkspaceInput,
  CreateWorkspaceOnRemoteInput,
  UpdateRemoteWorkspaceInput,
} from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
  AddWorkspaceSecondaryButton,
} from './primitives'

const CREATE_NEW_VALUE = '__create_new__'

interface ReconnectWorkspace {
  workspaceId: string
  name: string
  url: string
  remoteWorkspaceId: string
  hasCredential: boolean
}

interface AddWorkspaceStep_ConnectRemoteProps {
  onBack: () => void
  onConnect: (input: ConnectRemoteWorkspaceInput) => Promise<void>
  onCreateRemote: (input: CreateWorkspaceOnRemoteInput) => Promise<void>
  onUpdate: (input: UpdateRemoteWorkspaceInput) => Promise<void>
  isCreating: boolean
  reconnectWorkspace?: ReconnectWorkspace
}

export function AddWorkspaceStep_ConnectRemote({
  onBack,
  onConnect,
  onCreateRemote,
  onUpdate,
  isCreating,
  reconnectWorkspace,
}: AddWorkspaceStep_ConnectRemoteProps) {
  const { t } = useTranslation()
  const isReconnectMode = !!reconnectWorkspace
  const [serverUrl, setServerUrl] = useState(reconnectWorkspace?.url ?? '')
  const [token, setToken] = useState('')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [selectedValue, setSelectedValue] = useState<string | null>(null)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const selectPortalRef = useRef<HTMLDivElement>(null)

  const isCreateNew = selectedValue === CREATE_NEW_VALUE
  const selectedWorkspace = !isCreateNew
    ? remoteWorkspaces.find(workspace => workspace.id === selectedValue)
    : null
  const isFreshServer = testState === 'ok' && remoteWorkspaces.length === 0

  useEffect(() => {
    setTestState('idle')
    setTestError(null)
    setRemoteWorkspaces([])
    setSelectedValue(null)
    setNewWorkspaceName('')
  }, [serverUrl, token])

  const handleTestConnection = useCallback(async () => {
    const url = serverUrl.trim()
    const nextToken = token.trim()
    if (!url || !nextToken) return

    setTestState('testing')
    setTestError(null)
    try {
      const result = await window.electronAPI.testRemoteConnection(url, nextToken)
      if (!result.ok) {
        setTestState('error')
        setTestError(result.error || 'Connection failed')
        return
      }

      setTestState('ok')
      setServerVersion(result.serverVersion ?? null)
      const workspaces = result.needsWorkspace ? [] : (result.remoteWorkspaces ?? [])
      setRemoteWorkspaces(workspaces)
      if (workspaces.length === 1) setSelectedValue(workspaces[0]!.id)
    } catch (error) {
      setTestState('error')
      setTestError(error instanceof Error ? error.message : 'Connection failed')
    }
  }, [serverUrl, token])

  const handleConnect = useCallback(async () => {
    const url = serverUrl.trim()
    const nextToken = token.trim()
    if (!url) return

    try {
      if (reconnectWorkspace) {
        await onUpdate({
          workspaceId: reconnectWorkspace.workspaceId,
          url,
          remoteWorkspaceId: reconnectWorkspace.remoteWorkspaceId,
          ...(token.trim() ? { token: token.trim() } : {}),
        })
      } else if (isCreateNew || isFreshServer) {
        const name = newWorkspaceName.trim()
        if (!name || !nextToken) return
        await onCreateRemote({ url, token: nextToken, name })
      } else if (selectedWorkspace && nextToken) {
        await onConnect({
          name: selectedWorkspace.name,
          url,
          token: nextToken,
          remoteWorkspaceId: selectedWorkspace.id,
        })
      }
    } catch (error) {
      setTestState('error')
      setTestError(error instanceof Error ? error.message : 'Workspace connection failed')
    }
  }, [
    serverUrl,
    token,
    reconnectWorkspace,
    onUpdate,
    isCreateNew,
    isFreshServer,
    newWorkspaceName,
    onCreateRemote,
    selectedWorkspace,
    onConnect,
  ])

  const sameReconnectEndpoint = reconnectWorkspace
    ? serverUrl.trim() === reconnectWorkspace.url.trim()
    : false
  const canReuseCredential = !!reconnectWorkspace?.hasCredential && sameReconnectEndpoint && !token.trim()
  const reconnectReady = isReconnectMode && !!serverUrl.trim()
    && (canReuseCredential || (!!token.trim() && testState === 'ok'))
  const createReady = !isReconnectMode && testState === 'ok'
    && ((isFreshServer || isCreateNew) ? !!newWorkspaceName.trim() : !!selectedWorkspace)
  const canConnect = !isCreating && (reconnectReady || createReady)
  const showCreateMode = !isReconnectMode && (isCreateNew || isFreshServer)
  const buttonLabel = isReconnectMode ? 'Reconnect' : showCreateMode ? 'Create and Connect' : 'Connect'
  const buttonLoadingLabel = isReconnectMode ? 'Reconnecting...' : showCreateMode ? 'Creating...' : 'Connecting...'

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
        title={isReconnectMode
          ? t('workspace.reconnect', { name: reconnectWorkspace.name })
          : t('workspace.connectRemote')} // UA12.206
        description={isReconnectMode
          ? t('workspace.reconnectDescription')
          : t('workspace.connectRemoteDescription')}
      />

      <div className="mt-6 w-full space-y-5">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">{t('workspace.serverUrl')}</label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={serverUrl}
              onChange={event => setServerUrl(event.target.value)}
              placeholder="ws://192.168.1.100:9100"
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent shadow-none font-mono text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">{t('workspace.token')}</label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              type="password"
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder={t('workspace.serverAuthToken')}
              disabled={isCreating}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AddWorkspaceSecondaryButton
            onClick={handleTestConnection}
            disabled={!serverUrl.trim() || !token.trim() || testState === 'testing' || isCreating}
          >
            {testState === 'testing' ? t('workspace.testingConnection') : t('workspace.testConnection')}
          </AddWorkspaceSecondaryButton>
          {testState === 'ok' && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              {t('workspace.remoteConnected')}{serverVersion ? ` — v${serverVersion}` : ''}
              {isFreshServer ? ` — ${t('workspace.remoteNoWorkspacesYet')}` : ''}
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {testError || t('common.failed')}
            </span>
          )}
        </div>

        {testState === 'ok' && !serverVersion && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-700 dark:text-yellow-400">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{t('workspace.olderServerWarning')}</span>
          </div>
        )}

        <div ref={selectPortalRef} />

        {!isReconnectMode && testState === 'ok' && remoteWorkspaces.length > 0 && !isCreateNew && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">{t('workspace.workspaceLabel')}</label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Select
                value={selectedValue ?? ''}
                onValueChange={setSelectedValue}
                disabled={isCreating}
              >
                <SelectTrigger className="border-0 bg-transparent shadow-none">
                  <SelectValue placeholder={t('workspace.selectWorkspacePlaceholder')} />
                </SelectTrigger>
                <SelectContent container={selectPortalRef.current}>
                  {remoteWorkspaces.map(workspace => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              onClick={() => setSelectedValue(CREATE_NEW_VALUE)}
              disabled={isCreating}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t('workspace.createNewOnServer')}
            </button>
          </div>
        )}

        {!isReconnectMode && testState === 'ok' && showCreateMode && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">{t('workspace.nameLabel')}</label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Input
                value={newWorkspaceName}
                onChange={event => setNewWorkspaceName(event.target.value)}
                placeholder={t('workspace.myRemoteWorkspace')}
                disabled={isCreating}
                className="border-0 bg-transparent shadow-none"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('workspace.createOnServerHint')}
            </p>
            {isCreateNew && remoteWorkspaces.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedValue(remoteWorkspaces.length === 1 ? remoteWorkspaces[0]!.id : null)
                  setNewWorkspaceName('')
                }}
                disabled={isCreating}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                {t('workspace.useExistingWorkspace')}
              </button>
            )}
          </div>
        )}

        <AddWorkspacePrimaryButton
          onClick={handleConnect}
          disabled={!canConnect}
          loading={isCreating}
          loadingText={buttonLoadingLabel}
        >
          {buttonLabel}
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}
