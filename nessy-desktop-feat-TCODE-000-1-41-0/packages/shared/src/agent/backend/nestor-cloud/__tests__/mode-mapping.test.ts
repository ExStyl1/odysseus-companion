import { describe, expect, it } from 'bun:test';
import { mapPermissionModeToNestorCloudMode, resolveNestorCloudModeId } from '../mode-mapping.ts';

describe('mapPermissionModeToNestorCloudMode', () => {
  it('maps read-only planning modes to A2A plan and execution-capable modes to act', () => {
    // F1.1050: the retired explore arm became dontAsk's — the read-only remote mode F1.1070's composer matches.
    expect(mapPermissionModeToNestorCloudMode('dontAsk')).toBe('plan');
    expect(mapPermissionModeToNestorCloudMode('plan')).toBe('plan');
    expect(mapPermissionModeToNestorCloudMode('default')).toBe('act');
    expect(mapPermissionModeToNestorCloudMode('acceptEdits')).toBe('act');
    expect(mapPermissionModeToNestorCloudMode('auto')).toBe('act');
    expect(mapPermissionModeToNestorCloudMode('bypassPermissions')).toBe('act');
  });

  it('uses live remote mode ids when an AgentCard catalog is available', () => {
    const catalog = {
      defaultModeId: 'review',
      modeOptions: [{
        mode: 'default' as const,
        label: 'Review',
        shortLabel: 'Review',
        description: 'Remote Review mode.',
        iconMode: 'default' as const,
        remoteModeId: 'review',
      }],
    };

    expect(resolveNestorCloudModeId('default', catalog)).toBe('review');
    expect(resolveNestorCloudModeId('bypassPermissions', catalog)).toBe('review');
    expect(resolveNestorCloudModeId('plan', null)).toBe('plan');

    expect(resolveNestorCloudModeId('bypassPermissions', {
      defaultModeId: 'plan',
      modeOptions: [
        { mode: 'plan', label: 'Plan', remoteModeId: 'plan' },
        { mode: 'default', label: 'Review', remoteModeId: 'review' },
      ],
    })).toBe('review');
  });
});
