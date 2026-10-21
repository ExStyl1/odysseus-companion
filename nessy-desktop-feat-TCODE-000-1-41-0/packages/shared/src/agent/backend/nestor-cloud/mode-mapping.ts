import type { PermissionMode } from '../../mode-types.ts';
import type { CloudComposerModeOption } from '../types.ts';

export type NestorCloudA2AMode = 'plan' | 'act' | (string & {});

export interface NestorCloudModeMappingCatalog {
  modeOptions?: readonly CloudComposerModeOption[];
  defaultModeId?: string;
}

export function mapPermissionModeToNestorCloudMode(mode: PermissionMode): 'plan' | 'act' {
  switch (mode) {
    // `dontAsk` maps to the read-only remote mode: the remote side has no
    // never-prompt mode, and `act` would let it mutate without any local gate.
    case 'dontAsk':
    case 'plan':
      return 'plan';
    case 'default':
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions':
      return 'act';
  }
}

export function resolveNestorCloudModeId(
  mode: PermissionMode,
  catalog?: NestorCloudModeMappingCatalog | null,
): NestorCloudA2AMode {
  const fallbackModeId = mapPermissionModeToNestorCloudMode(mode);
  const representativeMode = fallbackModeId === 'plan' ? 'plan' : 'default';
  const matched = catalog?.modeOptions?.find(option =>
    option.mode === mode || option.remoteModeId === fallbackModeId
    || option.mode === representativeMode
  );
  return matched?.remoteModeId ?? catalog?.defaultModeId ?? fallbackModeId;
}
