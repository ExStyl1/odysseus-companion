import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// [nessy-fork] statist-trusted-ca
const CA_FILE_NAMES = ['tinkoff-bundle.crt', 'russian-root-ca.crt'];

// [nessy-fork] desktop-first-run-setup
export function resolveDesktopCaPaths(
  appPath: string,
  cwd: string,
  explicitPath?: string,
): string[] {
  if (explicitPath && existsSync(explicitPath)) return [explicitPath];

  const visited = new Set<string>();
  for (const startPath of [appPath, cwd]) {
    let directory = startPath;
    while (!visited.has(directory)) {
      visited.add(directory);
      const candidateDirectories = [
        join(directory, 'vendor', 'nessy-cli', 'certs'),
        join(directory, 'dist', 'certs'),
        join(directory, 'certs'),
      ];
      for (const candidateDirectory of candidateDirectories) {
        const matches = CA_FILE_NAMES.map((fileName) =>
          join(candidateDirectory, fileName),
        ).filter((candidate) => existsSync(candidate));
        if (matches.length > 0) return matches;
      }

      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return [];
}

export function resolveDesktopCaPath(
  appPath: string,
  cwd: string,
  explicitPath?: string,
): string | undefined {
  return resolveDesktopCaPaths(appPath, cwd, explicitPath)[0];
}
