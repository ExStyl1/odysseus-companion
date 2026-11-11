'use strict';
/** Official n8n.ready extension. Private Desktop handoff, never a public login bypass endpoint.
 * Contract: https://docs.n8n.io/deploy/host-n8n/configure-n8n/external-hooks
 * Internal services are pinned to n8n 2.35.7 and covered by the real-engine release acceptance. */
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
module.exports = { n8n: { ready: [async function () {
  const runtime = process.env.ODYSSEUS_N8N_RUNTIME;
  if (!process.send || !runtime) throw Error('Odysseus Desktop handoff is not configured');
  const req = createRequire(join(runtime, 'node_modules/n8n/package.json'));
  const { Container } = req('@n8n/di');
  const { UserRepository, ApiKeyRepository } = req('@n8n/db');
  const { OwnershipService } = req('./dist/services/ownership.service.js');
  const { AuthService } = req('./dist/auth/auth.service.js');
  const { PublicApiKeyService, API_KEY_AUDIENCE } = req('./dist/services/public-api-key.service.js');
  const ownership = Container.get(OwnershipService);
  if (!await ownership.hasInstanceOwner()) await ownership.setupOwner({ email: 'desktop@odysseus.local', firstName: 'Odysseus', lastName: 'Desktop', password: randomBytes(48).toString('base64url') + 'Aa1!' });
  const owner = await Container.get(UserRepository).findOne({ where: { role: { slug: 'global:owner' } }, relations: ['role'] });
  if (!owner || owner.disabled) throw Error('Local owner unavailable');
  // Never claim MFA was verified, reset an existing password or replace the existing owner.
  const keyService = Container.get(PublicApiKeyService), scopes = ['workflow:read','workflow:list','workflow:create','workflow:update','workflow:activate','workflow:deactivate','execution:read','execution:list'];
  const label = 'Odysseus Desktop local bridge';
  let key = await Container.get(ApiKeyRepository).findOneBy({ userId: owner.id, label, audience: API_KEY_AUDIENCE });
  if (!key) {
    if (!keyService.apiKeyHasValidScopesForRole(owner, scopes)) throw Error('n8n owner does not support the requested API scopes');
    key = await keyService.createPublicApiKeyForUser(owner, { label, expiresAt: null, scopes });
  }
  const send = id => process.send({ type: 'odysseus-entry', id, cookie: Container.get(AuthService).issueJWT(owner, false), apiKey: key.apiKey, ownerId: owner.id, pid: process.pid });
  process.on('message', message => { if (message?.type === 'odysseus-editor-session') send(message.id); });
  send(0);
}] } };
