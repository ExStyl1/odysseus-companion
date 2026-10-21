/**
 * WSL (Windows Subsystem for Linux) detection without VSCode API.
 * Ported from assistant's auth/wsl.ts.
 */

import { exec } from 'node:child_process';

// [nessy-fork] dp-auth
export function isRunningInWSL(): boolean {
  return !!(process.env['WSL_DISTRO_NAME'] || process.env['WSLENV']);
}

export function isWSLViewInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('command -v wslview', (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
