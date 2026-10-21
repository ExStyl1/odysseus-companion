declare const NESSY_AGENT_CLI_VERSION: string | undefined;

export function getCurrentVersion(): string {
  if (typeof NESSY_AGENT_CLI_VERSION !== 'undefined' && NESSY_AGENT_CLI_VERSION != null) {
    return NESSY_AGENT_CLI_VERSION;
  }
  return "0.0.1";
}

export async function isUpToDate(): Promise<boolean> {
  return true;
}

/**
 * Returns the latest version or null if the app is up to date
 */
export async function getUpdateToVersion(): Promise<string | null> {
  return null;
}
