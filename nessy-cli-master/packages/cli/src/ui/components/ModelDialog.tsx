/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import process from 'node:process';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  MAINLINE_CODER_MODEL,
  resolveModelId,
  type AvailableModel as CoreAvailableModel,
  type ContentGeneratorConfig,
  type InputModalities,
} from '@nestor/nessy-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
import {
  formatUnsupportedVoiceModelMessage,
  isSelectableVoiceModel,
} from '../voice/voice-model.js';

function formatModalities(modalities?: InputModalities): string {
  if (!modalities) return t('text-only');
  const parts: string[] = [];
  if (modalities.image) parts.push(t('image'));
  if (modalities.pdf) parts.push(t('pdf'));
  if (modalities.audio) parts.push(t('audio'));
  if (modalities.video) parts.push(t('video'));
  if (parts.length === 0) return t('text-only');
  return `${t('text')} · ${parts.join(' · ')}`;
}

/**
 * Build a unique selection key for a model entry in the model dialog.
 * When baseUrl is present, it's appended after a \0 separator to ensure
 * entries with the same model id but different baseUrls get distinct keys.
 */
function buildModelSelectionKey(
  authType: string,
  modelId: string,
  baseUrl?: string,
): string {
  const base = `${authType}::${modelId}`;
  return baseUrl ? `${base}\0${baseUrl}` : base;
}

/**
 * Parse a model selection key back into its components.
 */
function parseModelSelectionKey(key: string): {
  authType: string;
  modelId: string;
  baseUrl?: string;
} {
  const sep = '::';
  const idx = key.indexOf(sep);
  if (idx < 0) return { authType: '', modelId: key };

  const authType = key.slice(0, idx);
  const rest = key.slice(idx + sep.length);
  const nullIdx = rest.indexOf('\0');
  if (nullIdx >= 0) {
    return {
      authType,
      modelId: rest.slice(0, nullIdx),
      baseUrl: rest.slice(nullIdx + 1),
    };
  }
  return { authType, modelId: rest };
}

interface ModelDialogProps {
  onClose: () => void;
  // [nessy-fork] model-alias-fast
  isFastModelMode?: boolean;
  isVoiceModelMode?: boolean;
  // [nessy-fork] model-alias-visual
  isVisualModelMode?: boolean;
}

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return `(${t('not set')})`;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return `(${t('not set')})`;
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

function persistModelSelection(
  settings: ReturnType<typeof useSettings>,
  authType: AuthType | undefined,
  modelId: string,
  baseUrl?: string,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'model.name', modelId);
  // [nessy-fork] dp-auth-runtime-model-catalog
  if (authType === AuthType.DP_AUTH) {
    settings.setValue(scope, 'model.baseUrl', undefined);
    return;
  }
  // [nessy-fork] model-baseurl-disambiguation
  // Persist the paired baseUrl so the correct provider is restored on next
  // launch when multiple providers share the same model id. When the selection
  // has no baseUrl, write an empty-string tombstone (not undefined): undefined
  // is dropped from JSON, so it would not override a stale model.baseUrl left
  // in a lower-priority scope, whereas '' is a present value that does.
  settings.setValue(scope, 'model.baseUrl', baseUrl ?? '');
}

function persistAuthTypeSelection(
  settings: ReturnType<typeof useSettings>,
  authType: AuthType,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'security.auth.selectedType', authType);
}

function isImageCapable(model: CoreAvailableModel): boolean {
  return (
    model.visualOnly === true ||
    model.isVision === true ||
    model.modalities?.image === true
  );
}

function selectionToScopedModel(selected: string): string {
  if (selected.includes('::')) {
    const parsed = parseModelSelectionKey(selected);
    return `${parsed.authType}:${parsed.modelId}`;
  }
  if (selected.startsWith('$runtime|')) {
    const parts = selected.split('|');
    return parts[1] && parts[2] ? `${parts[1]}:${parts[2]}` : selected;
  }
  return selected;
}

function hydrateApiKeyEnvFromSettings(
  settings: ReturnType<typeof useSettings>,
  envKey: string | undefined,
): void {
  if (!envKey || process.env[envKey]) {
    return;
  }
  const settingsEnvValue = (
    settings?.merged?.env as Record<string, unknown> | undefined
  )?.[envKey];
  if (
    typeof settingsEnvValue === 'string' &&
    settingsEnvValue.trim().length > 0
  ) {
    process.env[envKey] = settingsEnvValue;
  }
}

interface HandleModelSwitchSuccessParams {
  settings: ReturnType<typeof useSettings>;
  uiState: UIState | null;
  after: ContentGeneratorConfig | undefined;
  effectiveAuthType: AuthType | undefined;
  effectiveModelId: string;
  effectiveBaseUrl: string | undefined;
  isRuntime: boolean;
}

function handleModelSwitchSuccess({
  settings,
  uiState,
  after,
  effectiveAuthType,
  effectiveModelId,
  effectiveBaseUrl,
  isRuntime,
}: HandleModelSwitchSuccessParams): void {
  persistModelSelection(
    settings,
    effectiveAuthType,
    effectiveModelId,
    effectiveBaseUrl,
  );
  if (effectiveAuthType) {
    persistAuthTypeSelection(settings, effectiveAuthType);
  }

  const baseUrl = after?.baseUrl ?? t('(default)');
  const maskedKey = maskApiKey(after?.apiKey);
  uiState?.historyManager.addItem(
    {
      type: 'info',
      text:
        `authType: ${effectiveAuthType ?? `(${t('none')})`}` +
        `\n` +
        `Using ${isRuntime ? 'runtime ' : ''}model: ${effectiveModelId}` +
        `\n` +
        `Base URL: ${baseUrl}` +
        `\n` +
        `API key: ${maskedKey}`,
    },
    Date.now(),
  );
}

function formatContextWindow(size?: number): string {
  if (!size) return `(${t('unknown')})`;
  return `${size.toLocaleString('en-US')} tokens`;
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box>
      <Box minWidth={16} flexShrink={0}>
        <Text color={theme.text.secondary}>{label}:</Text>
      </Box>
      <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}

export function ModelDialog({
  onClose,
  isFastModelMode,
  isVoiceModelMode,
  isVisualModelMode,
}: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const uiState = useContext(UIStateContext);
  const settings = useSettings();

  // Local error state for displaying errors within the dialog
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  // Force re-render when models are loaded from cache
  const [, setModelGeneration] = useState(0);

  const authType = config?.getAuthType();

  // Subscribe to model changes to re-render when DP_AUTH cache is loaded
  useEffect(() => {
    if (!config || typeof config.onModelChange !== 'function') return;
    const unsubscribe = config.onModelChange(() => {
      setModelGeneration((g) => g + 1);
    });
    return unsubscribe;
  }, [config]);

  const availableModelEntries = useMemo(() => {
    const allModels = config ? config.getAllConfiguredModels() : [];

    // Separate runtime models from registry models
    const runtimeModels = allModels.filter(
      (m) => m.isRuntimeModel && (!isVisualModelMode || isImageCapable(m)),
    );
    // [nessy-fork] qwen-oauth-discontinued-removal
    const registryModels = allModels.filter(
      (m) =>
        !m.isRuntimeModel &&
        (isVisualModelMode
          ? isImageCapable(m) && !m.fastOnly && !m.voiceOnly
          : true) &&
        // For DP Auth: filter by fastOnly flag based on mode
        // - In fast mode: show only fastOnly models
        // - In normal mode: show only non-fastOnly models
        // For other auth types: use standard logic
        // - In fast mode: show all models (no filtering)
        // - In normal mode: show only non-fastOnly models
        (m.authType === AuthType.DP_AUTH
          ? isFastModelMode
            ? m.fastOnly
            : !m.fastOnly
          : isFastModelMode || !m.fastOnly) &&
        (isVoiceModelMode || !m.voiceOnly) &&
        (isVisualModelMode || !m.visualOnly),
    );

    // Group registry models by authType
    const modelsByAuthTypeMap = new Map<AuthType, CoreAvailableModel[]>();
    for (const model of registryModels) {
      const authType = model.authType;
      if (!modelsByAuthTypeMap.has(authType)) {
        modelsByAuthTypeMap.set(authType, []);
      }
      modelsByAuthTypeMap.get(authType)!.push(model);
    }

    // Fixed order: dp-auth first, then others in a stable order
    const authTypeOrder: AuthType[] = [
      AuthType.DP_AUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];

    // Filter to only include authTypes that have registry models and maintain order
    const availableAuthTypes = new Set(modelsByAuthTypeMap.keys());
    const orderedAuthTypes = authTypeOrder.filter((t) =>
      availableAuthTypes.has(t),
    );

    // Build ordered list: runtime models first, then registry models grouped by authType
    const result: Array<{
      authType: AuthType;
      model: CoreAvailableModel;
      isRuntime?: boolean;
      snapshotId?: string;
    }> = [];

    // Add all runtime models first
    for (const runtimeModel of runtimeModels) {
      result.push({
        authType: runtimeModel.authType,
        model: runtimeModel,
        isRuntime: true,
        snapshotId: runtimeModel.runtimeSnapshotId,
      });
    }

    // Add registry models grouped by authType
    for (const t of orderedAuthTypes) {
      for (const model of modelsByAuthTypeMap.get(t) ?? []) {
        result.push({ authType: t, model, isRuntime: false });
      }
    }

    return result;
  }, [authType, config, isFastModelMode, isVoiceModelMode, isVisualModelMode]);

  const MODEL_OPTIONS = useMemo(
    () =>
      availableModelEntries.map(
        ({ authType: t2, model, isRuntime, snapshotId }) => {
          const value =
            isRuntime && snapshotId
              ? snapshotId
              : buildModelSelectionKey(t2, model.id, model.baseUrl);

          const title = (
            <Text>
              <Text
                bold
                color={
                  isRuntime ? theme.status.warning : theme.text.accent
                }
              >
                [{t2}]
              </Text>
              <Text>{` ${model.label}`}</Text>
            </Text>
          );

          const description = model.description || '';

          return {
            value,
            title,
            description,
            key: value,
          };
        },
      ),
    [availableModelEntries],
  );

  // In fast model mode, default to the currently configured fast model
  const fastModelSetting = settings?.merged?.fastModel as string | undefined;
  const voiceModelSetting = settings?.merged?.voiceModel as string | undefined;
  const visualModelSetting = settings?.merged?.visualModel as
    | string
    | undefined;
  const parsedFastModelSetting = useMemo(() => {
    if (!isFastModelMode) return undefined;
    try {
      return resolveModelId(fastModelSetting);
    } catch {
      return undefined;
    }
  }, [fastModelSetting, isFastModelMode]);
  const parsedVisualModelSetting = useMemo(() => {
    if (!isVisualModelMode) return undefined;
    try {
      return resolveModelId(visualModelSetting);
    } catch {
      return undefined;
    }
  }, [visualModelSetting, isVisualModelMode]);
  const preferredModelId =
    isFastModelMode && parsedFastModelSetting
      ? parsedFastModelSetting.modelId
      : isVisualModelMode && parsedVisualModelSetting
        ? parsedVisualModelSetting.modelId
      : config?.getModel() || MAINLINE_CODER_MODEL;
  // Check if current model is a runtime model
  // Runtime snapshot ID is already in $runtime|${authType}|${modelId} format
  const activeRuntimeSnapshot =
    isFastModelMode || isVoiceModelMode || isVisualModelMode
      ? undefined // special model selectors are never main runtime selections
      : config?.getActiveRuntimeModelSnapshot?.();
  const currentBaseUrl = config
    ?.getModelsConfig()
    .getGenerationConfig()?.baseUrl;
  // When `/model --fast <bare-id>` validated the model across all providers,
  // the setting persists as a bare model ID (no authType prefix) so that
  // runtime cross-auth lookups still work. Highlight the row that owns it
  // regardless of which provider that turns out to be — otherwise the
  // dialog would default to the current auth's first row and Enter would
  // silently overwrite the user's fast-model setting.
  const preferredFastModelEntry =
    isFastModelMode && parsedFastModelSetting
      ? parsedFastModelSetting.authType
        ? availableModelEntries.find(
            ({ authType: t2, model }) =>
              t2 === parsedFastModelSetting.authType &&
              model.id === parsedFastModelSetting.modelId,
          )
        : availableModelEntries.find(
            ({ model }) => model.id === parsedFastModelSetting.modelId,
          )
      : undefined;
  const preferredVoiceModelEntry =
    isVoiceModelMode && voiceModelSetting
      ? availableModelEntries.find(
          ({ model }) => model.id === voiceModelSetting,
        )
      : undefined;
  const preferredVisualModelEntry =
    isVisualModelMode && parsedVisualModelSetting
      ? parsedVisualModelSetting.authType
        ? availableModelEntries.find(
            ({ authType: t2, model }) =>
              t2 === parsedVisualModelSetting.authType &&
              model.id === parsedVisualModelSetting.modelId,
          )
        : availableModelEntries.find(
            ({ model }) => model.id === parsedVisualModelSetting.modelId,
          )
      : undefined;
  const preferredKey = activeRuntimeSnapshot
    ? activeRuntimeSnapshot.id
    : preferredVisualModelEntry
      ? buildModelSelectionKey(
          preferredVisualModelEntry.authType,
          preferredVisualModelEntry.model.id,
          preferredVisualModelEntry.model.baseUrl,
        )
      : preferredVoiceModelEntry
      ? buildModelSelectionKey(
          preferredVoiceModelEntry.authType,
          preferredVoiceModelEntry.model.id,
          preferredVoiceModelEntry.model.baseUrl,
        )
      : preferredFastModelEntry
        ? buildModelSelectionKey(
            preferredFastModelEntry.authType,
            preferredFastModelEntry.model.id,
            preferredFastModelEntry.model.baseUrl,
          )
        : authType
          ? buildModelSelectionKey(authType, preferredModelId, currentBaseUrl)
          : '';

  useKeypress(
    (key) => {
      if (
        key.name === 'escape' ||
        (key.name === 'left' &&
          (isFastModelMode || isVoiceModelMode || isVisualModelMode))
      ) {
        onClose();
      }
    },
    { isActive: true },
  );

  const initialIndex = useMemo(() => {
    const index = MODEL_OPTIONS.findIndex(
      (option) => option.value === preferredKey,
    );
    return index === -1 ? 0 : index;
  }, [MODEL_OPTIONS, preferredKey]);

  const handleHighlight = useCallback((value: string) => {
    setHighlightedValue(value);
  }, []);

  const highlightedEntry = useMemo(() => {
    const key = highlightedValue ?? preferredKey;
    return availableModelEntries.find(
      ({ authType: t2, model, isRuntime, snapshotId }) => {
        const v =
          isRuntime && snapshotId
            ? snapshotId
            : buildModelSelectionKey(t2, model.id, model.baseUrl);
        return v === key;
      },
    );
  }, [highlightedValue, preferredKey, availableModelEntries]);

  const handleSelect = useCallback(
    async (selected: string) => {
      setErrorMessage(null);
      const selectedEntry = availableModelEntries.find(
        ({ authType: t2, model, isRuntime, snapshotId }) => {
          const value =
            isRuntime && snapshotId
              ? snapshotId
              : buildModelSelectionKey(t2, model.id, model.baseUrl);
          return value === selected;
        },
      );

      if (isVoiceModelMode) {
        if (!selectedEntry) {
          setErrorMessage(t('Selected voice model is unavailable.'));
          return;
        }

        const voiceModel = selectedEntry.model.id;
        if (!isSelectableVoiceModel(selectedEntry.model)) {
          setErrorMessage(formatUnsupportedVoiceModelMessage(voiceModel));
          return;
        }

        const matchingEntries = availableModelEntries.filter(
          ({ model }) => model.id === voiceModel,
        );
        if (matchingEntries.length > 1) {
          setErrorMessage(
            t(
              "Voice model '{{model}}' is configured more than once. Remove duplicate model ids before selecting it for voice transcription.",
              { model: voiceModel },
            ),
          );
          return;
        }

        const scope = getPersistScopeForModelSelection(settings);
        settings.setValue(scope, 'voiceModel', voiceModel);
        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `${t('Voice Model')}: ${voiceModel}`,
          },
          Date.now(),
        );
        onClose();
        return;
      }

      hydrateApiKeyEnvFromSettings(settings, selectedEntry?.model.envKey);

      // [nessy-fork] model-alias-fast
      if (isFastModelMode) {
        const fastModel = selectionToScopedModel(selected);
        const scope = getPersistScopeForModelSelection(settings);
        settings.setValue(scope, 'fastModel', fastModel);
        // Sync the runtime Config so forked agents pick up the change immediately.
        config?.setFastModel(fastModel);
        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `${t('Fast Model')}: ${fastModel}`,
          },
          Date.now(),
        );
        onClose();
        return;
      }

      if (isVisualModelMode) {
        if (!selectedEntry || !isImageCapable(selectedEntry.model)) {
          setErrorMessage(t('Selected visual model is unavailable.'));
          return;
        }
        const visualModel = selectionToScopedModel(selected);
        const scope = getPersistScopeForModelSelection(settings);
        settings.setValue(scope, 'visualModel', visualModel);
        config?.setVisualModel(visualModel);
        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `${t('Visual Model')}: ${visualModel}`,
          },
          Date.now(),
        );
        onClose();
        return;
      }

      let after: ContentGeneratorConfig | undefined;
      let effectiveAuthType: AuthType | undefined;
      let effectiveModelId = selected;
      let isRuntime = false;

      if (!config) {
        onClose();
        return;
      }

      // Capture internal flags before switching to detect internal ↔ external transition.
      const prevEntry = availableModelEntries.find(
        (e) =>
          (e.isRuntime && e.snapshotId
            ? e.snapshotId
            : `${e.authType}::${e.model.id}`) === preferredKey,
      );
      const nextEntry = availableModelEntries.find(
        (e) =>
          (e.isRuntime && e.snapshotId
            ? e.snapshotId
            : `${e.authType}::${e.model.id}`) === selected,
      );
      const contextWillBeCleared =
        prevEntry?.model.internal === true &&
        nextEntry?.model.internal !== true;

      try {
        // Determine if this is a runtime model selection
        // Runtime model format: $runtime|${authType}|${modelId}
        isRuntime = selected.startsWith('$runtime|');

        let selectedAuthType: AuthType;
        let modelId: string;

        let selectedBaseUrl: string | undefined;
        if (isRuntime) {
          // For runtime models, extract authType from the snapshot ID
          // Format: $runtime|${authType}|${modelId}
          const parts = selected.split('|');
          if (parts.length >= 2 && parts[0] === '$runtime') {
            selectedAuthType = parts[1] as AuthType;
          } else {
            selectedAuthType = authType as AuthType;
          }
          modelId = selected; // Pass the full snapshot ID to switchModel
        } else {
          const parsed = parseModelSelectionKey(selected);
          selectedAuthType = (parsed.authType || authType) as AuthType;
          modelId = parsed.modelId;
          selectedBaseUrl = parsed.baseUrl;
        }

        await config.switchModel(selectedAuthType, modelId, {
          ...(selectedAuthType !== authType &&
          selectedAuthType === AuthType.DP_AUTH
            ? { requireCachedCredentials: true }
            : {}),
          baseUrl: selectedBaseUrl,
        });

        if (!isRuntime) {
          const event = new ModelSlashCommandEvent(modelId);
          logModelSlashCommand(config, event);
        }

        after = config.getContentGeneratorConfig?.() as
          | ContentGeneratorConfig
          | undefined;
        effectiveAuthType = after?.authType ?? selectedAuthType ?? authType;
        effectiveModelId = after?.model ?? modelId;

        handleModelSwitchSuccess({
          settings,
          uiState,
          after,
          effectiveAuthType,
          effectiveModelId,
          // [nessy-fork] model-baseurl-disambiguation
          // Persist the selected provider's baseUrl so the right provider is
          // restored next launch when several share the same id. Pair it with the
          // same resolved config that effectiveModelId comes from (`after`) so the
          // persisted (model.name, model.baseUrl) stays consistent even if
          // switchModel transforms the id; fall back to the picker entry's
          // baseUrl. Runtime models are keyed by snapshot id, so no disambiguator.
          effectiveBaseUrl: isRuntime
            ? undefined
            : (after?.baseUrl ?? selectedEntry?.model.baseUrl),
          isRuntime,
        });

        if (contextWillBeCleared) {
          uiState?.historyManager.addItem(
            {
              type: 'info',
              text: t(
                'Context cleared: switched from internal to external model.',
              ),
            },
            Date.now(),
          );
        }
      } catch (e) {
        const baseErrorMessage = e instanceof Error ? e.message : String(e);
        // Use parsed modelId for display to avoid showing raw selection key
        // (which contains invisible \0 separator between modelId and baseUrl)
        const displayModelId = isRuntime
          ? effectiveModelId
          : parseModelSelectionKey(selected).modelId;
        const errorPrefix = isRuntime
          ? 'Failed to switch to runtime model.'
          : `Failed to switch model to '${displayModelId}'.`;
        setErrorMessage(`${errorPrefix}\n\n${baseErrorMessage}`);
        return;
      }

      onClose();
    },
    [
      authType,
      config,
      onClose,
      settings,
      uiState,
      setErrorMessage,
      isFastModelMode,
      isVoiceModelMode,
      isVisualModelMode,
      availableModelEntries,
    ],
  );

  const hasModels = MODEL_OPTIONS.length > 0;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {isVoiceModelMode
          ? t('Select Voice Model')
          : isVisualModelMode
            ? t('Select Visual Model')
          : isFastModelMode
            ? t('Select Fast Model')
            : t('Select Model')}
      </Text>

      {!hasModels ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            {t(
              'No models available for the current authentication type ({{authType}}).',
              {
                authType: authType ? String(authType) : t('(none)'),
              },
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t(
                'Please configure models in settings.modelProviders or use environment variables.',
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={MODEL_OPTIONS}
            onSelect={handleSelect}
            onHighlight={handleHighlight}
            initialIndex={initialIndex}
            showNumbers={true}
          />
        </Box>
      )}

      {highlightedEntry && (
        <Box marginTop={1} flexDirection="column">
          <Box
            borderStyle="single"
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor={theme.border.default}
          />
          <DetailRow
            label={t('Modality')}
            value={formatModalities(highlightedEntry.model.modalities)}
          />
          <DetailRow
            label={t('Context Window')}
            value={formatContextWindow(
              highlightedEntry.model.contextWindowSize,
            )}
          />
          {highlightedEntry.authType !== AuthType.DP_AUTH && (
            <>
              <DetailRow
                label="Base URL"
                value={highlightedEntry.model.baseUrl ?? t('(default)')}
              />
              <DetailRow
                label="API Key"
                value={highlightedEntry.model.envKey ?? t('(not set)')}
              />
            </>
          )}
        </Box>
      )}

      {errorMessage && (
        <Box marginTop={1} flexDirection="column" paddingX={1}>
          <Text color={theme.status.error} wrap="wrap">
            ✕ {errorMessage}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Enter to select, ↑↓ to navigate, Esc to close')}
        </Text>
      </Box>
    </Box>
  );
}
