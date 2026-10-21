// Version is read from the repository root package.json: the single source of truth.
// Workspace package.json versions may differ from the desktop app release version.
import pkg from '../../../../package.json';

export const APP_VERSION: string = pkg.version;

export function getAppVersion(): string {
  return APP_VERSION;
}

export * from './version.ts';
