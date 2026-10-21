import { extname } from 'node:path';
import { resolveContainedPath } from '@nessy-agent/shared/workspaces';

const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function resolveWorkspaceIconPath(workspaceRoot: string, filename: string): string {
  if (!/^icon\.[A-Za-z0-9]+$/.test(filename) || !ICON_EXTENSIONS.has(extname(filename).toLowerCase())) {
    throw new Error('Invalid workspace icon filename');
  }
  return resolveContainedPath(workspaceRoot, filename);
}
