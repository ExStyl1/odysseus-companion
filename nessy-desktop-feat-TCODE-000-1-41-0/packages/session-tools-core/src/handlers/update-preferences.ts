/**
 * Update User Preferences Handler
 *
 * Updates stored user preferences (name, timezone, location, notes).
 * Uses an injected updatePreferences callback to avoid depending on @nessy-agent/shared.
 *
 * Note: UI language is NOT user-editable here — it mirrors Appearance → Language
 * and is maintained internally by the main-process i18n IPC handler.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface UpdatePreferencesArgs {
  name?: string;
  timezone?: string;
  city?: string;
  region?: string;
  country?: string;
  notes?: string;
  includeCoAuthoredBy?: boolean;
  /** P6.441 — the four newer git-attribution keys, flat (see `tool-defs.ts`). */
  attributionCommit?: string;
  attributionPr?: string;
  attributionSessionUrl?: boolean;
  includeGitInstructions?: boolean;
  prUrlTemplate?: string;
}

/**
 * Handle the update_user_preferences tool call.
 *
 * Validates and merges preference updates, then delegates to the
 * context-provided updatePreferences callback for actual persistence.
 */
export async function handleUpdatePreferences(
  ctx: SessionToolContext,
  args: UpdatePreferencesArgs
): Promise<ToolResult> {
  if (!ctx.updatePreferences) {
    return errorResponse('Preferences update is not available in this environment.');
  }

  try {
    const updates: Record<string, unknown> = {};

    if (args.name && typeof args.name === 'string') {
      updates.name = args.name;
    }
    if (args.timezone && typeof args.timezone === 'string') {
      updates.timezone = args.timezone;
    }

    // Handle location fields
    if (args.city || args.region || args.country) {
      const location: Record<string, string> = {};
      if (args.city && typeof args.city === 'string') {
        location.city = args.city;
      }
      if (args.region && typeof args.region === 'string') {
        location.region = args.region;
      }
      if (args.country && typeof args.country === 'string') {
        location.country = args.country;
      }
      updates.location = location;
    }

    // Handle notes (replace)
    if (args.notes && typeof args.notes === 'string') {
      updates.notes = args.notes;
    }

    // Handle co-author preference (explicit boolean)
    if (typeof args.includeCoAuthoredBy === 'boolean') {
      updates.includeCoAuthoredBy = args.includeCoAuthoredBy;
    }

    // P6.441 — the four newer attribution keys. The two STRINGS are merged with
    // `!== undefined` and NOT with a truthiness test, because `''` is the
    // documented way to hide a part (`settings-reference.md#attribution-commit`:
    // "Set it to an empty string to hide commit attribution") — a truthy guard
    // would silently discard the one value an operator uses to turn it off.
    //
    // Only the sub-keys the caller NAMED are sent. The merge belongs to the
    // writer, which already merges `location` and `diffViewer` the same way, so
    // setting `attributionPr` alone cannot erase a stored `attributionCommit`.
    // This handler has no reader of its own and must not grow one for it.
    const attribution: Record<string, unknown> = {};
    let attributionTouched = false;
    if (typeof args.attributionCommit === 'string') {
      attribution.commit = args.attributionCommit;
      attributionTouched = true;
    }
    if (typeof args.attributionPr === 'string') {
      attribution.pr = args.attributionPr;
      attributionTouched = true;
    }
    if (typeof args.attributionSessionUrl === 'boolean') {
      attribution.sessionUrl = args.attributionSessionUrl;
      attributionTouched = true;
    }
    if (attributionTouched) updates.attribution = attribution;
    if (typeof args.includeGitInstructions === 'boolean') {
      updates.includeGitInstructions = args.includeGitInstructions;
    }
    if (typeof args.prUrlTemplate === 'string') {
      updates.prUrlTemplate = args.prUrlTemplate;
    }

    // Check if anything was actually updated
    const fields = Object.keys(updates).filter(k => k !== 'location');
    if (updates.location) {
      fields.push(...Object.keys(updates.location as Record<string, string>).map(k => `location.${k}`));
    }

    if (fields.length === 0) {
      return successResponse('No preferences were updated (no valid fields provided)');
    }

    ctx.updatePreferences(updates);
    return successResponse(`Updated user preferences: ${fields.join(', ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to update preferences: ${message}`);
  }
}
