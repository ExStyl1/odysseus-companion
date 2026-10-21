/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/ai-settings-loader.ts (UB15.10; ADDED in v0.15.0),
 * ADAPTED to OUR pick of the page's initial reads.
 *
 * What differs from upstream, and why:
 *  - The pick is ours. Upstream reads seven values; this page also seeds the output style (plus its options for
 *    the active workspace), guardian (switch, legacy global model, per-integration map), advisor (switch, model),
 *    codex auto-review (switch, policy) and codex subagents from the same first paint, so all of them join the
 *    one `Promise.all` rather than trailing it.
 *  - NO `getEnable1MContext`: the Extended context switch is gone (F1.1241, each Claude model runs with its own
 *    context window), so the snapshot carries no `enable1M` field.
 *  - `workspaceId` is the third argument because `listOutputStyles` lists the active workspace's own styles;
 *    upstream has no output-style read.
 */
import type { ElectronAPI } from '../../../shared/types'

type AiSettingsApi = Pick<ElectronAPI,
  'getWorkspaces' | 'getDefaultThinkingLevel' | 'getOutputStyle' | 'listOutputStyles' | 'getExtendedPromptCache' |
  'getRtkEnabled' | 'getRtkStatus' | 'getGuardianEnabled' | 'getGuardianModel' | 'getGuardianModelsByConnection' |
  'getAdvisorEnabled' | 'getAdvisorModel' | 'getCodexAutoReviewEnabled' | 'getCodexAutoReviewPolicy' |
  'getCodexSubagentsEnabled' | 'getCredentialHealth'>

/** Load the initial page as one snapshot, including the connection list and health banner.
 * Sequential RPCs used to insert whole sections above already-visible controls. */
export async function loadAiSettings(
  api: AiSettingsApi,
  refreshConnections: () => Promise<void>,
  workspaceId?: string,
) {
  const [
    workspaces, thinking, outputStyle, outputStyles, extendedCache, rtkEnabled, rtkStatus,
    guardianEnabled, guardianModel, guardianModels, advisorEnabled, advisorModel,
    codexAutoReviewEnabled, codexAutoReviewPolicy, codexSubagentsEnabled, health,
  ] = await Promise.all([
    api.getWorkspaces(),
    api.getDefaultThinkingLevel(),
    api.getOutputStyle(),
    api.listOutputStyles(workspaceId),
    api.getExtendedPromptCache(),
    api.getRtkEnabled(),
    api.getRtkStatus(),
    api.getGuardianEnabled(),
    api.getGuardianModel(),
    // The per-integration judge map (H1). The legacy global above stays loaded — the resolver still reads it as a
    // fallback — but the picker shows and writes this.
    api.getGuardianModelsByConnection(),
    api.getAdvisorEnabled(),
    api.getAdvisorModel(),
    api.getCodexAutoReviewEnabled(),
    api.getCodexAutoReviewPolicy(),
    api.getCodexSubagentsEnabled(),
    api.getCredentialHealth(),
    refreshConnections(),
  ])
  return {
    workspaces, thinking, outputStyle, outputStyles, extendedCache, rtkEnabled, rtkStatus,
    guardianEnabled, guardianModel, guardianModels, advisorEnabled, advisorModel,
    codexAutoReviewEnabled, codexAutoReviewPolicy, codexSubagentsEnabled, health,
  }
}
