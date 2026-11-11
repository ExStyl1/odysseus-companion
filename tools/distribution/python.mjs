/** Bundle a standalone Python and the pinned Graphify environment; downloads happen only at build time. */
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
export function stagePython({ root, electron, payload, copy, run, uv = join(electron, `resources/bin/darwin-${process.arch}/uv`) }) {
  const cache = join(root, '.odysseus/runtime/python');
  mkdirSync(cache, { recursive: true });
  let candidates = () =>
    readdirSync(cache)
      .filter((n) => !n.startsWith('.') && existsSync(join(cache, n, 'bin/python3.12')))
      .sort()
      .reverse();
  if (!candidates().length)
    run(uv, ['python', 'install', '--no-bin', '--install-dir', cache, '3.12'], root);
  const source = realpathSync(join(cache, candidates()[0])),
    target = join(payload, 'python');
  copy(join(source, 'bin/python3.12'), join(target, 'bin/python3'));
  for (const name of readdirSync(join(source, 'lib'))) {
    if (name === 'python3.12') {
      for (const child of readdirSync(join(source, 'lib', name)))
        if (child !== 'site-packages')
          copy(join(source, 'lib', name, child), join(target, 'lib', name, child));
    } else copy(join(source, 'lib', name), join(target, 'lib', name));
  }
  if (existsSync(join(source, 'share'))) copy(join(source, 'share'), join(target, 'share'));
  const packages = join(target, 'lib/python3.12/site-packages'),
    installed = join(root, '.odysseus/graphify/venv/lib/python3.12/site-packages');
  if (existsSync(installed)) copy(installed, packages);
  else
    run(
      uv,
      [
        'pip',
        'install',
        '--python',
        join(target, 'bin/python3'),
        '--target',
        packages,
        '--requirements',
        join(root, 'shared/skills/graphify/requirements.txt'),
      ],
      root,
    );
  writeFileSync(
    join(target, 'run'),
    '#!/bin/sh\nunset PYTHONHOME PYTHONPATH\nexport PYTHONNOUSERSITE=1\nexec "$(dirname "$0")/bin/python3" -I "$@"\n',
  );
  chmodSync(join(target, 'run'), 0o755);
  run(
    join(target, 'run'),
    [
      '-c',
      'import graphify, mcp, ssl; import importlib.metadata as m; assert m.version("graphifyy")=="0.9.92"; print("Bundled Graphify and Python verified")',
    ],
    root,
  );
}
