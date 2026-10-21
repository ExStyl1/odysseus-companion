/**
 * Local HTTP stub for POST /api/v2/token. No real gateway is ever contacted.
 * Records inbound Authorization headers so tests can assert which token was
 * exchanged (never printing the value).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubServer {
  url: string;
  /** Bearer tokens seen on inbound requests, in order. */
  authTokens: string[];
  requestCount(): number;
  close(): Promise<void>;
}

export interface StubConfig {
  /** JWT to return on success (200). */
  jwt?: string;
  /** Force a non-2xx status instead of returning a jwt. */
  status?: number;
  /** Body text for the error status. */
  errorBody?: string;
  /** Delay before responding (ms) — to exercise timeout. */
  delayMs?: number;
}

export async function startStubExchangeServer(config: StubConfig): Promise<StubServer> {
  const authTokens: string[] = [];
  let count = 0;

  const server: Server = createServer((req, res) => {
    count += 1;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      authTokens.push(auth.slice('Bearer '.length));
    }
    // Drain the request body.
    req.on('data', () => {});
    req.on('end', () => {
      const respond = () => {
        if (config.status && config.status >= 400) {
          res.writeHead(config.status, { 'Content-Type': 'text/plain' });
          res.end(config.errorBody ?? 'error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            token: { created_at: 'x', id: 'y', expires_at: 'z' },
            jwt: config.jwt ?? '',
          }),
        );
      };
      if (config.delayMs) setTimeout(respond, config.delayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/api/v2/token`,
    authTokens,
    requestCount: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
