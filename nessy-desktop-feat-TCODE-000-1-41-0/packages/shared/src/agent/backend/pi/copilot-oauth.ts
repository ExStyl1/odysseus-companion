import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';

/**
 * Pi 0.84 made `@earendil-works/pi-ai/oauth` a TYPE-ONLY entry point: the
 * `loginGitHubCopilot` / `refreshGitHubCopilotToken` value exports Nessy used
 * are gone. Both flows stay reachable through the public provider factory,
 * whose `auth.oauth` is the very same implementation
 * (`dist/auth/oauth/github-copilot.js`) behind a lazy wrapper. This module is
 * the one place that knows that, so a future Pi move needs one edit.
 */
async function githubCopilotOAuth(): Promise<OAuthAuth> {
  const { githubCopilotProvider } = await import('@earendil-works/pi-ai/providers/github-copilot');
  const oauth = githubCopilotProvider().auth.oauth;
  if (!oauth) {
    throw new Error('GitHub Copilot OAuth is not available in the installed Pi runtime');
  }
  return oauth;
}

/** Callback shape Nessy's RPC handler already speaks. */
export interface GitHubCopilotLoginCallbacks {
  onDeviceCode(input: { userCode: string; verificationUri: string }): void;
  /** GitHub Enterprise domain; return '' for github.com. */
  onPrompt?(): Promise<string> | string;
  onProgress?(message: string): void;
  signal: AbortSignal;
}

/**
 * Run the GitHub Copilot device-code login.
 *
 * 0.84 replaced the flat `{ onDeviceCode, onPrompt, onProgress, signal }`
 * options object with an `AuthInteraction` (`prompt()` + `notify(event)`), so
 * the adaptation is here rather than at the call site. The flow itself is
 * unchanged — device code, poll, Copilot token exchange, model policy enable.
 */
export async function loginGitHubCopilotCredential(
  callbacks: GitHubCopilotLoginCallbacks,
): Promise<OAuthCredential> {
  const oauth = await githubCopilotOAuth();
  return oauth.login({
    signal: callbacks.signal,
    prompt: async () => (await callbacks.onPrompt?.()) ?? '',
    notify: event => {
      switch (event.type) {
        case 'device_code':
          callbacks.onDeviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
          });
          break;
        case 'progress':
        case 'info':
          callbacks.onProgress?.(event.message);
          break;
        case 'auth_url':
          callbacks.onProgress?.(event.instructions ?? event.url);
          break;
      }
    },
  });
}

/**
 * Exchange a GitHub OAuth access token for a short-lived Copilot API
 * credential.
 *
 * Pi 0.84 removed `refreshGitHubCopilotToken` — and every other VALUE export —
 * from `@earendil-works/pi-ai/oauth`, which is now a type-only compatibility
 * entry point. The same exchange stays reachable through the public provider
 * factory: `githubCopilotProvider().auth.oauth.refresh(credential, signal)`
 * calls the identical internal `refreshGitHubCopilotToken(credential.refresh,
 * …)` and returns the same `{ type, refresh, access, expires }` shape, so this
 * is a re-routing of the same call rather than a reimplementation.
 *
 * `access` and `expires` on the input credential are placeholders: the refresh
 * path reads only `credential.refresh` and an optional `enterpriseUrl`, which
 * Nessy does not persist.
 */
export async function refreshGitHubCopilotCredential(
  githubToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const oauth = await githubCopilotOAuth();
  return oauth.refresh(
    { type: 'oauth', refresh: githubToken, access: '', expires: 0 },
    signal ?? new AbortController().signal,
  );
}
