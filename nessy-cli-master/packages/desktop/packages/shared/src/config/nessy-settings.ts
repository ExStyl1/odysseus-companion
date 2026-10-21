export interface NessyMemorySettings {
  enableManagedAutoMemory: boolean;
  enableManagedAutoDream: boolean;
  enableAutoSkill: boolean;
}

export interface NessyMemoryPaths {
  userMemoryFile: string;
  projectMemoryFile: string;
  autoMemoryDir: string;
}

export type NessyMemoryPathTarget = 'user' | 'project' | 'auto';

export const DEFAULT_NESSY_MEMORY_SETTINGS: NessyMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: false,
  enableAutoSkill: false,
};

type JsonRecord = Record<string, unknown>;

export function normalizeNessyMemorySettings(
  value: unknown,
): NessyMemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_NESSY_MEMORY_SETTINGS };
  }

  const memoryRecord = value as JsonRecord;
  return {
    enableManagedAutoMemory:
      typeof memoryRecord.enableManagedAutoMemory === 'boolean'
        ? memoryRecord.enableManagedAutoMemory
        : DEFAULT_NESSY_MEMORY_SETTINGS.enableManagedAutoMemory,
    enableManagedAutoDream:
      typeof memoryRecord.enableManagedAutoDream === 'boolean'
        ? memoryRecord.enableManagedAutoDream
        : DEFAULT_NESSY_MEMORY_SETTINGS.enableManagedAutoDream,
    enableAutoSkill:
      typeof memoryRecord.enableAutoSkill === 'boolean'
        ? memoryRecord.enableAutoSkill
        : DEFAULT_NESSY_MEMORY_SETTINGS.enableAutoSkill,
  };
}
