import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export function findNessy(env = process.env) {
  const search = path => {
    for (const dir of (path || '').split(delimiter).filter(isAbsolute)) {
      const command = join(dir, 'nessy');
      try {
        accessSync(command, constants.X_OK);
        if (statSync(command).isFile()) return { command, path };
      } catch {}
    }
  };
  const configured = search(env.PATH);
  if (configured) return configured;
  if (process.platform === 'darwin') {
    const shell = spawnSync('/bin/zsh', ['-lc', 'printf "%s" "$PATH"'], {
      env, encoding: 'utf8', timeout: 4000,
    });
    if (shell.status === 0) {
      const login = search(shell.stdout.trim());
      if (login) return login;
    }
  }
  return search([join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH].join(delimiter));
}
