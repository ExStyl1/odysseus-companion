/** Build the child Electron environment without turning an absent config root into a custom root. */
export function buildElectronDevEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const configDir = source.NESSY_CONFIG_DIR;

  Object.assign(env, {
    VITE_DEV_SERVER_URL: `http://localhost:${source.NESSY_VITE_PORT || '5173'}`,
    NESSY_APP_NAME: source.NESSY_APP_NAME || 'Nessy Desktop',
    NESSY_DEEPLINK_SCHEME: source.NESSY_DEEPLINK_SCHEME || 'nessy',
    NESSY_INSTANCE_NUMBER: source.NESSY_INSTANCE_NUMBER || '',
  });

  if (configDir?.trim()) env.NESSY_CONFIG_DIR = configDir;
  else delete env.NESSY_CONFIG_DIR;

  return env;
}
