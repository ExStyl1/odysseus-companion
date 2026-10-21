/**
 * The bundled pi-agent-server inlines @earendil-works/pi-coding-agent, whose
 * config.js resolves VERSION/piConfig by walking up from the bundle to the
 * nearest package.json. Without this file the walk lands on an unrelated
 * manifest (packages/pi-agent-server in dev, the Electron app when packaged)
 * and the runtime adapter rejects the session with "Unsupported Pi runtime".
 * Write the real Pi package identity next to the bundle so the walk stops here.
 *
 * P7.3/P7.10 — THE WALK IS NO LONGER ENOUGH ON ITS OWN, and this file is the one
 * that will otherwise read as still-true. Since `0.84.3` (re-read at `0.84.4` on
 * 2026-09-13 by C3.380 lift 3, at `0.85.1` on 2026-09-24 by F1.255 and at `0.87.1`
 * on 2026-10-10 by UA12.211, unchanged each time) `getPackageDir()` delegates
 * to a new `findNodePackageDir()` carrying one extra rule: if the directory is
 * named `dist` and its PARENT also has a `package.json`, the parent wins. The dev
 * bundle is literally `packages/pi-agent-server/dist`, so the walk now steps past
 * the file written below and lands on the wrapper manifest — `Unsupported Pi
 * runtime 1.0.2`. The host closes it with the runtime's own first branch,
 * `PI_PACKAGE_DIR`, set to this directory at the spawn site
 * (`buildPiSubprocessEnv`, `packages/shared/src/agent/pi-agent.ts`).
 *
 * So this file is still REQUIRED — it is the manifest `PI_PACKAGE_DIR` points at,
 * and the packaged layout (whose directory is not named `dist`) still resolves it
 * by the walk alone. What changed is that it is no longer SUFFICIENT. The pair is
 * guarded end to end by
 * `packages/shared/src/agent/__tests__/pi-bundle-package-identity.test.ts`, which
 * runs the installed runtime's real resolver over both directory shapes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const piPackagePath = Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir);
const pi = JSON.parse(readFileSync(piPackagePath, 'utf8'));
const distPackage = {
  name: pi.name,
  version: pi.version,
  type: pi.type,
  ...(pi.piConfig ? { piConfig: pi.piConfig } : {}),
};
const outPath = join(import.meta.dir, '..', 'dist', 'package.json');
writeFileSync(outPath, `${JSON.stringify(distPackage, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outPath} (${pi.name}@${pi.version})`);
