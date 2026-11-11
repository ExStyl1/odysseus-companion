import assert from 'node:assert/strict';
import test from 'node:test';
import updates from '../../companion/updates.cjs';

test('uses the public release redirect when the GitHub API rejects the request', async () => {
  const calls = [];
  const fetchRelease = async (url, options) => {
    calls.push([url, options]);
    if (calls.length === 1) return new Response(null, { status: 403 });
    return new Response(null, { status: 302, headers: { Location: updates.releaseUrl('0.8.10') } });
  };
  assert.deepEqual(await updates.checkForUpdate({ fetchRelease, currentVersion: '0.8.9' }), {
    currentVersion: '0.8.9', latestVersion: '0.8.10', available: true,
  });
  assert.equal(calls[1][1].method, 'HEAD');
  assert.equal(calls[1][1].redirect, 'manual');
});

test('rejects redirects outside the Companion repository', async () => {
  const fetchRelease = async () => new Response(null, {
    status: 302, headers: { Location: 'https://example.com/releases/tag/companion-v0.8.10' },
  });
  await assert.rejects(updates.checkForUpdate({ fetchRelease }), /Не удалось проверить обновления/);
});
