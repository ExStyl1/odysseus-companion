import type { CloudComposerModeOption } from '../types.ts';
import type { NestorAgentCard, NestorAgentCardExtension } from './types.ts';

export const NESTOR_AGENT_SETTINGS_EXTENSION_URI = 'urn:a2a:extension:agent-settings:v1';

export interface NestorCloudAgentCardModeCatalog {
  modeOptions: CloudComposerModeOption[];
  defaultModeId: string;
  remoteModeIds: string[];
}

const KNOWN_REMOTE_MODES: Record<string, CloudComposerModeOption> = {
  plan: {
    mode: 'plan',
    label: 'Plan',
    shortLabel: 'Plan',
    description: 'Remote planning mode. The agent develops a strategy without applying changes.',
    iconMode: 'plan',
    remoteModeId: 'plan',
  },
  act: {
    mode: 'default',
    label: 'Act',
    shortLabel: 'Act',
    description: 'Remote implementation mode. Nessy still asks before local tool execution.',
    iconMode: 'default',
    remoteModeId: 'act',
  },
};

export function parseNestorCloudAgentCardModes(
  card: NestorAgentCard,
): NestorCloudAgentCardModeCatalog | null {
  const extension = readAgentSettingsExtension(card);
  if (!extension) return null;

  const remoteModeIds = readRemoteModeIds(extension);
  if (remoteModeIds.length === 0) return null;

  const defaultModeId = remoteModeIds.includes('act') ? 'act' : remoteModeIds[0]!;
  const modeOptions = buildCloudModeOptions(remoteModeIds);
  if (modeOptions.length === 0) return null;

  return { modeOptions, defaultModeId, remoteModeIds };
}

function readAgentSettingsExtension(card: NestorAgentCard): NestorAgentCardExtension | null {
  for (const extension of readExtensions(card)) {
    if (extension.uri === NESTOR_AGENT_SETTINGS_EXTENSION_URI) {
      return extension;
    }
  }
  return null;
}

function readExtensions(card: NestorAgentCard): NestorAgentCardExtension[] {
  const extensions: NestorAgentCardExtension[] = [];
  // The card nests its extension list under `capabilities` on BOTH wires
  // (`a2a/agent.go:47-49` → `AgentCapabilities.Extensions`; the v1 card is the
  // same object rendered by the 0.3 compat producer, `usecase_nessy.go:90`).
  // The two top-level spellings below are read defensively, not from the spec.
  if (Array.isArray(card.capabilities?.extensions)) {
    extensions.push(...card.capabilities.extensions);
  }
  if (Array.isArray(card.extensions)) {
    extensions.push(...card.extensions);
  }
  if (Array.isArray(card.extension)) {
    extensions.push(...card.extension);
  } else if (isRecord(card.extension)) {
    extensions.push(card.extension as NestorAgentCardExtension);
  }
  return extensions;
}

function readRemoteModeIds(extension: NestorAgentCardExtension): string[] {
  const params = extension.params;
  if (!isRecord(params)) return [];

  const agentSettingsSchema = params.agentSettingsSchema;
  if (!isRecord(agentSettingsSchema)) return [];

  const properties = agentSettingsSchema.properties;
  if (!isRecord(properties)) return [];

  const mode = properties.mode;
  if (!isRecord(mode) || !Array.isArray(mode.enum)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of mode.enum) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildCloudModeOptions(remoteModeIds: string[]): CloudComposerModeOption[] {
  const options: CloudComposerModeOption[] = [];
  const seenLocalModes = new Set<string>();
  const hasKnownAct = remoteModeIds.includes('act');

  for (const remoteModeId of remoteModeIds) {
    const known = KNOWN_REMOTE_MODES[remoteModeId];
    const option = known
      ? { ...known }
      : (!hasKnownAct ? buildFallbackActModeOption(remoteModeId) : null);
    if (!option || seenLocalModes.has(option.mode)) continue;
    seenLocalModes.add(option.mode);
    options.push(option);
  }

  return options;
}

function buildFallbackActModeOption(remoteModeId: string): CloudComposerModeOption {
  const label = titleFromModeId(remoteModeId);
  return {
    mode: 'default',
    label,
    shortLabel: label,
    description: `Remote ${label} mode.`,
    iconMode: 'default',
    remoteModeId,
  };
}

function titleFromModeId(id: string): string {
  return id
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
