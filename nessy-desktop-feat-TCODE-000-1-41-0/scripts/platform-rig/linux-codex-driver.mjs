#!/usr/bin/env node
/**
 * The JSON-RPC driver `run-linux-codex-probe.mjs` runs INSIDE the container.
 *
 * Split into its own file for one reason: it must be readable as the thing that
 * actually talks to the binary. It reads its arms from `/in/arms.json` (written
 * by the host half) and prints one JSON array on stdout.
 *
 * `initialize` + `permissionProfile/list` + `command/exec` is the same handshake
 * `packages/codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts`
 * uses on darwin, so the two platforms are compared through one shape.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BIN = '/work/bin/codex-app-server';
const WS = '/work/ws';
const ARMS = JSON.parse(readFileSync('/in/arms.json', 'utf8'));

function makeWorkspace() {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(WS, 'a', 'b', 'c', '.env'), 'SECRET=decoy-value\n');
  writeFileSync(join(WS, 'a', 'b', 'c', 'plain.txt'), 'not a secret\n');
}

class AppServer {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); this.stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id);
          resolve(msg.error ? { __error: msg.error } : msg.result);
        }
      }
    });
    child.stderr.on('data', (d) => { this.stderr += d.toString(); });
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      const t = setTimeout(() => { this.pending.delete(id); resolve({ __timeout: true }); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); } });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  kill() { try { this.child.kill('SIGKILL'); } catch {} }
}

async function boot(name, toml) {
  const home = `/work/homes/${name}`;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), toml);
  const child = spawn(BIN, [], {
    cwd: WS,
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const server = new AppServer(child);
  const init = await server.request('initialize', {
    clientInfo: { name: 'nessy-linux-probe', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify('initialized');
  return { server, init };
}

async function arm(name, toml) {
  const { server, init } = await boot(name, toml);
  const listed = await server.request('permissionProfile/list', {}, 20000);
  const ours = listed?.data?.find?.((p) => p.id === 'nessy_runtime');
  const env = await server.request('command/exec', { command: ['cat', `${WS}/a/b/c/.env`], cwd: WS, timeoutMs: 15000 }, 40000);
  const plain = await server.request('command/exec', { command: ['cat', `${WS}/a/b/c/plain.txt`], cwd: WS, timeoutMs: 15000 }, 40000);
  const out = {
    arm: name,
    initialized: init && !init.__error && !init.__timeout,
    profileListed: ours ? { allowed: ours.allowed } : (listed?.__error ? 'rpc-error' : 'absent'),
    envRead: env?.__timeout ? 'timeout' : { exit: env?.exitCode, stdout: (env?.stdout ?? '').trim().slice(0, 60), stderr: (env?.stderr ?? '').trim().slice(0, 120) },
    plainRead: plain?.__timeout ? 'timeout' : { exit: plain?.exitCode, stdout: (plain?.stdout ?? '').trim().slice(0, 60), stderr: (plain?.stderr ?? '').trim().slice(0, 120) },
    stderrFirst: server.stderr.split('\n').filter(Boolean).slice(0, 4),
  };
  server.kill();
  return out;
}

makeWorkspace();
const results = [];
for (const spec of ARMS) results.push(await arm(spec.name, spec.toml));
console.log(JSON.stringify(results, null, 2));
