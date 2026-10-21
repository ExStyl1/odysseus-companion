// Only explicitly configured user credentials cross this boundary. Never harvest process.env.
import { cliConnections } from './models.mjs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { bytes, privateWrite, document, digest, reconcile } from './store.mjs';
export function readSecrets(privateDir) {
  const key = bytes(join(privateDir, 'bridge.key')),
    payload = bytes(join(privateDir, 'secrets.enc'));
  if (!payload) return {};
  if (!key || key.length !== 32) throw Error('Missing private bridge key');
  const data = JSON.parse(payload),
    decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString(),
  );
}
export function writeSecrets(privateDir, value) {
  const keyPath = join(privateDir, 'bridge.key');
  let key = bytes(keyPath);
  if (!key) {
    key = randomBytes(32);
    privateWrite(keyPath, key);
  }
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  privateWrite(
    join(privateDir, 'secrets.enc'),
    JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    }),
  );
}
export async function syncCredentials(paths, bindings, manager) {
  const cache = readSecrets(paths.privateDir),
    state = document(join(paths.privateDir, 'credential-state.json'), {
      fields: {},
    }),
    settings = document(join(paths.cliHome, 'settings.json'));
  const report = { conflicts: [], updatedSlugs: [] };
  let changed = false;
  for (const b of bindings) {
    if (b.auth === 'dp-auth') continue;
    const candidates = [
      ...new Set(b.envKeys.map((k) => settings.env?.[k]).filter((v) => typeof v === 'string' && v)),
    ];
    if (candidates.length > 1) {
      report.conflicts.push(`credential:${b.id}`);
      continue;
    }
    const cli = candidates[0],
      desktop = await manager.getLlmApiKey(b.slug);
    const fingerprint = (v) => (v ? digest(Buffer.from(v)) : undefined);
    const merged = reconcile(state, b.id, fingerprint(cli), fingerprint(desktop), report);
    if (merged.conflict) continue;
    let value =
      merged.value === fingerprint(cli)
        ? cli
        : merged.value === fingerprint(desktop)
          ? desktop
          : cache[b.id];
    // A deleted native credential invalidates the launch cache; it is never resurrected.
    if (merged.value === undefined) value = undefined;
    if (value && merged.value !== fingerprint(value)) continue;
    if (value && value !== desktop) {
      await manager.setLlmApiKey(b.slug, value);
      report.updatedSlugs.push(b.slug);
    }
    if (cache[b.id] !== value) {
      if (value) cache[b.id] = value;
      else delete cache[b.id];
      changed = true;
    }
    merged.accept(fingerprint(cli), fingerprint(value || desktop));
  }
  if (changed) writeSecrets(paths.privateDir, cache);
  privateWrite(join(paths.privateDir, 'credential-state.json'), JSON.stringify(state));
  return report;
}
export function credentialEnvironment(paths, bindings) {
  const cache = readSecrets(paths.privateDir),
    settings = document(join(paths.cliHome, 'settings.json')),
    state = document(join(paths.privateDir, 'credential-state.json'), {
      fields: {},
    }),
    env = {};
  for (const b of bindings) {
    const explicit = [
      ...new Set(b.envKeys.map((k) => settings.env?.[k]).filter((v) => typeof v === 'string' && v)),
    ];
    if (explicit.length > 1) continue;
    const localChanged =
      explicit[0] && digest(Buffer.from(explicit[0])) !== state.fields[b.id]?.cli;
    const value = localChanged ? explicit[0] : cache[b.id] || explicit[0];
    if (value) for (const key of b.envKeys) env[key] = value;
  }
  return env;
}

/** Reuse an existing, unexpired local DP token; never refresh or sign in here. */
export function existingDpToken(paths, now = Date.now()) {
  const candidates = [];
  for (const [file, field] of [
    ['oauth_creds.json', 'access_token'],
    ['dp_auth_creds.json', 'jwt'],
  ]) {
    try {
      const token = document(join(paths.cliHome, file))[field];
      if (typeof token !== 'string') continue;
      const parts = token.split('.');
      if (parts.length !== 3) continue;
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (Number.isFinite(claims.exp) && claims.exp * 1000 > now + 60000)
        candidates.push({ token, expires: claims.exp });
    } catch {
      /* A malformed/expired cache remains owned by its native auth flow. */
    }
  }
  return candidates.sort((a, b) => b.expires - a.expires)[0]?.token;
}

export function launchBindings(paths) {
  const settings = document(join(paths.cliHome, 'settings.json')),
    state = document(join(paths.privateDir, 'state.json'));
  return [...cliConnections(settings, { unsupported: [], conflicts: [] }).values()]
    .filter((c) => state.connections?.[c.id])
    .map((c) => ({
      id: c.id,
      auth: c.auth,
      slug: state.connections[c.id].slug,
      envKeys: [...new Set(c.refs.map((m) => m.envKey).filter(Boolean))],
    }));
}
