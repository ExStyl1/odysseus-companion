import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  getMcpBaseUrl,
  canonicalResourceIdentifier,
  discoverOAuthMetadata as discoverOAuthMetadataImpl,
  exchangeMcpOAuth as exchangeMcpOAuthImpl,
  prepareMcpOAuth as prepareMcpOAuthImpl,
  validateOAuthUrlForNetwork,
  withOAuthNetworkDependenciesForTests,
  NessyOAuth,
} from '../oauth';

let mockFetch: ReturnType<typeof mock>;
const resolvePublicTestHost = async () => [{ address: '203.0.114.10', family: 4 }];
const withTestNetwork = <T>(action: () => T): T => (
  withOAuthNetworkDependenciesForTests({
    fetchImpl: (url, options, addresses) => mockFetch(url, options, addresses),
    resolveHost: resolvePublicTestHost,
  }, action)
);
const discoverOAuthMetadata: typeof discoverOAuthMetadataImpl = (...args) => (
  withTestNetwork(() => discoverOAuthMetadataImpl(...args))
);
const prepareMcpOAuth: typeof prepareMcpOAuthImpl = (...args) => (
  withTestNetwork(() => prepareMcpOAuthImpl(...args))
);
const exchangeMcpOAuth: typeof exchangeMcpOAuthImpl = (...args) => (
  withTestNetwork(() => exchangeMcpOAuthImpl(...args))
);

// ============================================================
// Unit tests for internal helpers exported only for testing
// We test them indirectly through discoverOAuthMetadata where needed,
// and directly by importing from the module's source for non-exported helpers
// ============================================================

describe('getMcpBaseUrl', () => {
  it('extracts origin from standard MCP URL', () => {
    expect(getMcpBaseUrl('https://example.com/mcp')).toBe('https://example.com');
  });

  it('extracts origin from double-path URL (Ahrefs case)', () => {
    expect(getMcpBaseUrl('https://api.ahrefs.com/mcp/mcp')).toBe('https://api.ahrefs.com');
  });

  it('extracts origin from URL with port', () => {
    expect(getMcpBaseUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000');
  });

  it('extracts origin from URL with deep path', () => {
    expect(getMcpBaseUrl('https://company.com/api/v2/mcp')).toBe('https://company.com');
  });

  it('extracts origin from URL with query params', () => {
    expect(getMcpBaseUrl('https://example.com/mcp?version=1')).toBe('https://example.com');
  });

  it('extracts origin from URL with trailing slash', () => {
    expect(getMcpBaseUrl('https://example.com/mcp/')).toBe('https://example.com');
  });

  it('extracts origin from SSE endpoint', () => {
    expect(getMcpBaseUrl('https://mcp.linear.app/sse')).toBe('https://mcp.linear.app');
  });

  it('extracts origin from GitHub Copilot MCP', () => {
    expect(getMcpBaseUrl('https://api.githubcopilot.com/mcp/')).toBe('https://api.githubcopilot.com');
  });

  it('returns as-is for invalid URL', () => {
    expect(getMcpBaseUrl('not-a-valid-url')).toBe('not-a-valid-url');
  });

  it('returns as-is for empty string', () => {
    expect(getMcpBaseUrl('')).toBe('');
  });
});

describe('discoverOAuthMetadata', () => {
  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
  });

  describe('RFC 9728 protected resource discovery', () => {
    it('discovers metadata via WWW-Authenticate resource_metadata hint', async () => {
      const protectedResourceMetadata = {
        resource: 'https://mcp.example.com/my',
        authorization_servers: ['https://mcp.example.com/my/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://mcp.example.com/my/auth/authorize',
        token_endpoint: 'https://mcp.example.com/my/auth/token',
        registration_endpoint: 'https://mcp.example.com/my/auth/register',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request to MCP endpoint returns 401 with resource_metadata hint
        if (url === 'https://mcp.example.com/my/mcp' && options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/my"',
            },
          }));
        }
        // Protected resource metadata
        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/my') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        // Authorization server metadata
        if (url === 'https://mcp.example.com/my/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://mcp.example.com/my/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://mcp.example.com/my' }); // UB3.3: discovery now carries the PRM-declared resource
      expect(mockFetch.mock.calls.every(([, options]) => (
        (options as RequestInit | undefined)?.signal instanceof AbortSignal
      ))).toBe(true);
    });

    it('falls back to RFC 8414 when HEAD returns non-401', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request returns 200 (no auth required or different auth)
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to RFC 8414 when no resource_metadata in header', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request returns 401 but without resource_metadata
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer error="invalid_token"',
            },
          }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back when protected resource metadata fetch fails', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        // Protected resource metadata returns 404
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response('Not Found', { status: 404 }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to GET when HEAD returns 405', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD returns 405 Method Not Allowed
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // GET returns 401 with resource_metadata
        if (url === 'https://example.com/mcp' && options?.method === 'GET') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('falls back to POST when both HEAD and GET return 405 (Streamable HTTP)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD returns 405
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // GET also returns 405 (Streamable HTTP servers only accept POST)
        if (url === 'https://example.com/mcp' && options?.method === 'GET') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // POST returns 401 with resource_metadata
        if (url === 'https://example.com/mcp' && options?.method === 'POST') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('classifies real POST OAuth challenges without exposing or retaining discarded bodies', async () => {
      const cases = [
        { name: 'valid header', postStatus: 401, header: true, metadata: 'valid', expected: true },
        { name: 'missing header', postStatus: 401, header: false, metadata: 'none', expected: false },
        { name: 'forbidden', postStatus: 403, header: false, metadata: 'none', expected: false },
        { name: 'invalid metadata', postStatus: 401, header: true, metadata: 'invalid', expected: false },
      ] as const;

      for (const testCase of cases) {
        const cancelled: boolean[] = [];
        const methods: string[] = [];
        const discarded = (status: number, headers?: Record<string, string>) => {
          let wasCancelled = false;
          cancelled.push(false);
          const index = cancelled.length - 1;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('raw-provider-body'));
              controller.close();
            },
            cancel() {
              wasCancelled = true;
              cancelled[index] = true;
            },
          });
          const response = new Response(body, { status, headers });
          Object.defineProperty(response, '__wasCancelled', {
            get: () => wasCancelled,
          });
          return response;
        };

        mockFetch.mockImplementation((url: string, options?: RequestInit) => {
          methods.push(options?.method ?? 'GET');
          if (url === 'https://post.example.test/mcp' && options?.method === 'HEAD') {
            return Promise.resolve(discarded(405));
          }
          if (url === 'https://post.example.test/mcp' && options?.method === 'GET') {
            return Promise.resolve(discarded(405));
          }
          if (url === 'https://post.example.test/mcp' && options?.method === 'POST') {
            return Promise.resolve(discarded(testCase.postStatus, testCase.header ? {
              'WWW-Authenticate': 'Bearer resource_metadata="https://post.example.test/.well-known/oauth-protected-resource"',
            } : undefined));
          }
          if (url === 'https://post.example.test/.well-known/oauth-protected-resource') {
            return Promise.resolve(new Response(JSON.stringify({
              resource: 'https://post.example.test/mcp',
              authorization_servers: ['https://post.example.test/auth'],
            }), { status: 200 }));
          }
          if (url === 'https://post.example.test/auth/.well-known/oauth-authorization-server') {
            return Promise.resolve(new Response(JSON.stringify(testCase.metadata === 'valid' ? {
              authorization_endpoint: 'https://post.example.test/auth/authorize',
              token_endpoint: 'https://post.example.test/auth/token',
            } : {
              authorization_endpoint: 'raw-invalid-provider-metadata',
            }), { status: 200 }));
          }
          return Promise.resolve(discarded(404));
        });
        const logs: string[] = [];

        const result = await discoverOAuthMetadata(
          'https://post.example.test/mcp',
          message => logs.push(message),
        );

        expect(Boolean(result), testCase.name).toBe(testCase.expected);
        expect(methods).toContain('POST');
        expect(cancelled.every(Boolean), testCase.name).toBe(true);
        expect(logs.join('\n')).not.toContain('raw-provider');
      }
    });

    it('cancels a discovery response when its body reader fails', async () => {
      const cancel = mock(async () => {});
      const releaseLock = mock(() => {});
      let first = true;
      mockFetch.mockImplementation(() => {
        if (!first) return Promise.resolve(new Response('Not Found', { status: 404 }));
        first = false;
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: async () => { throw new Error('raw-read-error'); },
              cancel,
              releaseLock,
            }),
          },
        } as unknown as Response);
      });

      expect(await discoverOAuthMetadata('https://read-error.example.test/mcp')).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it('does not let discarded-body cancellation exceed the discovery deadline', async () => {
      const cancel = mock(() => new Promise<void>(() => {}));
      mockFetch.mockImplementation(() => Promise.resolve({
        status: 404,
        ok: false,
        headers: new Headers(),
        body: { cancel },
      } as unknown as Response));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'deadline'>(resolve => {
        timeout = setTimeout(() => resolve('deadline'), 25);
      });

      const outcome = await Promise.race([
        discoverOAuthMetadata('https://cancel-stall.example.test/mcp')
          .then(() => 'settled' as const),
        deadline,
      ]);
      if (timeout) clearTimeout(timeout);

      expect(outcome).toBe('settled');
      expect(cancel).toHaveBeenCalled();
    });

    it('falls back when authorization_servers is empty array', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: [], // Empty array
      };

      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back when protected resource returns malformed JSON', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response('not valid json {{{', { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('rejects resource_metadata URL pointing to private IP (SSRF protection)', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Malicious server tries to redirect to AWS metadata endpoint
              'WWW-Authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data/"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Should fall back to RFC 8414 instead of following SSRF URL
      expect(result).toEqual(metadata);
    });

    it('rejects resource_metadata URL with non-HTTPS scheme', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="http://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('handles trailing slash in authorization server URL', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth/'], // Trailing slash
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        // Should be normalized to single slash
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('parses resource_metadata with single quotes', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Single quotes instead of double quotes
              'WWW-Authenticate': "Bearer resource_metadata='https://example.com/.well-known/oauth-protected-resource'",
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });
  });

  describe('RFC 8414 discovery fallback', () => {
    it('discovers metadata at origin root', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails (no RFC 9728 support)
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to path-scoped discovery', async () => {
      const metadata = {
        authorization_endpoint: 'https://api.ahrefs.com/oauth/authorize',
        token_endpoint: 'https://api.ahrefs.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://api.ahrefs.com/.well-known/oauth-authorization-server/mcp/mcp') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://api.ahrefs.com/mcp/mcp');
      expect(result).toEqual(metadata);
    });
  });

  describe('error handling', () => {
    it('returns null when no metadata found', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

    it('returns null for invalid URL', async () => {
      const result = await discoverOAuthMetadata('not-a-valid-url');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null when metadata is missing required fields', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ some: 'data' }), { status: 200 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

    it('rejects oversized OAuth discovery responses before parsing', async () => {
      const logs: string[] = [];
      const oversizedBody = 'x'.repeat((256 * 1024) + 1);
      mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(oversizedBody, { status: 200 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp', message => logs.push(message));

      expect(result).toBeNull();
      expect(logs.some(message => message.includes('response body exceeds'))).toBe(true);
    });

    it('rejects an OAuth discovery redirect to an unsafe URL without fetching it', async () => {
      const logs: string[] = [];
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(null, {
            status: 302,
            headers: { Location: 'http://127.0.0.1/private-oauth-metadata' },
          }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp', message => logs.push(message));

      expect(result).toBeNull();
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('127.0.0.1'))).toBe(false);
      expect(logs.some(message => message.includes('Unsafe OAuth redirect rejected'))).toBe(true);
      expect(mockFetch.mock.calls.every(([, options]) => (
        (options as RequestInit | undefined)?.redirect === 'manual'
      ))).toBe(true);
    });

    it('rejects unsafe authorization, token, and registration endpoints from public metadata', async () => {
      const cases = [
        {
          authorization_endpoint: 'http://127.0.0.1/authorize',
          token_endpoint: 'https://accounts.example.com/token',
        },
        {
          authorization_endpoint: 'https://accounts.example.com/authorize',
          token_endpoint: 'http://169.254.169.254/token',
        },
        {
          authorization_endpoint: 'https://accounts.example.com/authorize',
          token_endpoint: 'https://accounts.example.com/token',
          registration_endpoint: 'http://127.0.0.1/register',
        },
      ];

      for (const metadata of cases) {
        mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
          if (options?.method === 'HEAD') {
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        });

        expect(await discoverOAuthMetadata('https://example.com/mcp')).toBeNull();
      }
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.reject(new Error('Network error'));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });
  });

  it('calls onLog callback with discovery progress', async () => {
    const logs: string[] = [];
    const onLog = (msg: string) => logs.push(msg);

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await discoverOAuthMetadata('https://example.com/mcp', onLog);

    expect(logs.some(l => l.includes('Discovering OAuth metadata'))).toBe(true);
    expect(logs.some(l => l.includes('RFC 9728'))).toBe(true);
    expect(logs.some(l => l.includes('No OAuth metadata found'))).toBe(true);
  });

  it('includes registration_endpoint when present', async () => {
    const metadata = {
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      registration_endpoint: 'https://example.com/oauth/register',
    };

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result?.registration_endpoint).toBe('https://example.com/oauth/register');
  });

  // ============================================================
  // SSRF Protection – isUrlSafeToFetch (tested via discoverOAuthMetadata)
  // ============================================================
  describe('SSRF protection via isUrlSafeToFetch', () => {
    // Helper: set up a 401 with resource_metadata pointing at the given URL
    function setupSsrfTest(resourceMetadataUrl: string) {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

    it('rejects IPv6 loopback ::1', async () => {
      const fallback = setupSsrfTest('https://[::1]/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects private and link-local IPv6 literals', async () => {
      expect(await validateOAuthUrlForNetwork('https://[fc00::1]/oauth')).toMatchObject({ safe: false });
      expect(await validateOAuthUrlForNetwork('https://[fe80::1]/oauth')).toMatchObject({ safe: false });
      expect(await validateOAuthUrlForNetwork('https://[::ffff:127.0.0.1]/oauth')).toMatchObject({ safe: false });
    });

    it('rejects a public hostname when any DNS answer is non-public', async () => {
      const result = await validateOAuthUrlForNetwork('https://oauth.attacker.example/token', async () => [
        { address: '203.0.114.10', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);

      expect(result).toEqual({
        safe: false,
        reason: 'OAuth hostname resolved to non-public address 127.0.0.1',
      });
    });

    it('bounds a stalled DNS resolver', async () => {
      const controller = new AbortController();
      const pending = validateOAuthUrlForNetwork(
        'https://oauth.attacker.example/token',
        async () => await new Promise(() => {}),
        controller.signal,
      );
      controller.abort();

      await expect(pending).resolves.toEqual({
        safe: false,
        reason: 'OAuth hostname resolution timed out',
      });
    });

    it('rejects 0.0.0.0', async () => {
      const fallback = setupSsrfTest('https://0.0.0.0/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 10.x.x.x private range', async () => {
      const fallback = setupSsrfTest('https://10.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 172.16.x.x private range', async () => {
      const fallback = setupSsrfTest('https://172.16.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 172.31.x.x private range (upper bound)', async () => {
      const fallback = setupSsrfTest('https://172.31.255.255/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 192.168.x.x private range', async () => {
      const fallback = setupSsrfTest('https://192.168.1.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 127.0.0.1 loopback', async () => {
      const fallback = setupSsrfTest('https://127.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects localhost', async () => {
      const fallback = setupSsrfTest('https://localhost/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects link-local 169.254.x.x (AWS metadata)', async () => {
      const fallback = setupSsrfTest('https://169.254.169.254/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects HTTP scheme (non-HTTPS)', async () => {
      const fallback = setupSsrfTest('http://safe-domain.com/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects authorization_servers pointing to private IP', async () => {
      // The protected resource metadata itself is safe, but the auth server points to a private IP
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://10.0.0.1/auth'],
      };

      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Should fall back because auth server URL is unsafe
      expect(result).toEqual(fallbackMetadata);
    });
  });

  // ============================================================
  // WWW-Authenticate header parsing edge cases
  // ============================================================
  describe('WWW-Authenticate header parsing edge cases', () => {
    it('handles resource_metadata with extra spaces around equals sign', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Extra spaces around =
              'WWW-Authenticate': 'Bearer resource_metadata  =  "https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('falls back when WWW-Authenticate header is null', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          // 401 but no WWW-Authenticate header
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('handles multiple WWW-Authenticate challenges (resource_metadata among other params)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Multiple params before and after resource_metadata
              'WWW-Authenticate': 'Bearer realm="example", error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource", error_description="expired"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('falls back when resource_metadata value has no quotes', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // No quotes around the value
              'WWW-Authenticate': 'Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Without quotes, parseResourceMetadataFromHeader returns null, so falls back
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back when WWW-Authenticate is empty string', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': '' },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });
  });

  // ============================================================
  // Protected resource metadata validation edge cases
  // ============================================================
  describe('protected resource metadata validation', () => {
    // Helper to set up 401 flow leading to a resource metadata response
    function setup401WithResourceMetadata(resourceMetadataBody: unknown) {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(
            JSON.stringify(resourceMetadataBody), { status: 200 }
          ));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

    it('falls back when resource metadata is null', async () => {
      const fallback = setup401WithResourceMetadata(null);
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when resource metadata is a string', async () => {
      const fallback = setup401WithResourceMetadata('not an object');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when resource metadata is missing "resource" field', async () => {
      const fallback = setup401WithResourceMetadata({
        authorization_servers: ['https://example.com/auth'],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when authorization_servers contains non-string items', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: [123, true],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when authorization_servers is not an array', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: 'not an array',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('succeeds when authorization_servers is absent but uses fallback', async () => {
      // resource metadata with no authorization_servers field at all
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });
  });

  // ============================================================
  // Timeout handling
  // ============================================================
  describe('timeout handling', () => {
    it('falls back when HEAD request times out (AbortError)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // Simulate abort on HEAD and GET for the MCP endpoint
        if (url === 'https://example.com/mcp') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back when protected resource metadata fetch times out', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        // Timeout on protected resource metadata
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('logs timeout message on AbortError for protected resource metadata', async () => {
      const logs: string[] = [];
      const onLog = (msg: string) => logs.push(msg);

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      await discoverOAuthMetadata('https://example.com/mcp', onLog);
      expect(logs.some(l => l.includes('timeout'))).toBe(true);
    });
  });

  // ============================================================
  // normalizeUrl behavior (tested via trailing slash in auth server)
  // ============================================================
  describe('URL normalization', () => {
    it('handles authorization server URL without trailing slash', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'], // No trailing slash
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });

    it('handles authorization server URL at root (no path)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://auth.example.com'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual({ ...authServerMetadata, resource: 'https://example.com/api' }); // UB3.3: discovery now carries the PRM-declared resource
    });
  });

  // ============================================================
  // HEAD returning other status codes
  // ============================================================
  describe('HEAD returning various non-401 status codes', () => {
    it('falls back on HEAD 403 (Forbidden)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back on HEAD 500 (Internal Server Error)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back on HEAD 301 (redirect)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 301 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });
  });
});

describe('prepareMcpOAuth', () => {
  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
  });

  it('pins each request and redirect hop to the addresses that passed validation', async () => {
    const resolved = [
      [{ address: '203.0.114.10', family: 4 }],
      [{ address: '203.0.114.11', family: 4 }],
    ];
    let resolution = 0;
    const pinnedFetch = mock((url: string, _options: RequestInit, addresses: unknown) => {
      if (url.endsWith('/token')) {
        return Promise.resolve(new Response(null, {
          status: 307,
          headers: { location: '/token-final' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'pinned-token',
        token_type: 'Bearer',
      }), { status: 200 }));
    });

    const result = await withOAuthNetworkDependenciesForTests({
      fetchImpl: pinnedFetch,
      resolveHost: async () => resolved[resolution++]!,
    }, () => exchangeMcpOAuthImpl({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://oauth.example.test/token',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1/oauth/callback',
    }));

    expect(result).toMatchObject({ success: true, accessToken: 'pinned-token' });
    expect(pinnedFetch.mock.calls.map(([, , addresses]) => addresses)).toEqual(resolved);
    expect(resolution).toBe(2);
  });

  it('uses an explicit protected resource for discovery, authorization, and token exchange', async () => {
    const transportUrl = 'https://mcp.notion.com/mcp';
    const oauthResource = 'https://mcp.notion.com';
    const tokenEndpoint = 'https://auth.notion.com/oauth/token';

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === oauthResource && options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === `${oauthResource}/.well-known/oauth-authorization-server`) {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.notion.com/oauth/authorize',
          token_endpoint: tokenEndpoint,
        }), { status: 200 }));
      }
      if (url === tokenEndpoint && options?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'access-1',
          token_type: 'Bearer',
          expires_in: 60,
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const prepared = await prepareMcpOAuth(transportUrl, {
      callbackUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'notion-client',
      oauthResource,
    });

    const authUrl = new URL(prepared.authUrl);
    expect(authUrl.searchParams.get('resource')).toBe(oauthResource);
    expect(prepared.oauthResource).toBe(oauthResource);
    expect(mockFetch.mock.calls.some(([url, options]) => (
      url === transportUrl && (options as RequestInit | undefined)?.method === 'HEAD'
    ))).toBe(false);

    const exchanged = await exchangeMcpOAuth({
      code: 'code-1',
      codeVerifier: prepared.codeVerifier,
      tokenEndpoint: prepared.tokenEndpoint,
      clientId: prepared.clientId,
      redirectUri: prepared.redirectUri,
      oauthResource: prepared.oauthResource,
    });

    expect(exchanged).toMatchObject({ success: true, accessToken: 'access-1' });
    const tokenRequest = mockFetch.mock.calls.find(([url]) => url === tokenEndpoint);
    expect(tokenRequest).toBeDefined();
    expect((tokenRequest?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    const tokenBody = new URLSearchParams(String((tokenRequest?.[1] as RequestInit | undefined)?.body));
    expect(tokenBody.get('resource')).toBe(oauthResource);
  });

  it('falls back to the default client ID when registration is forbidden', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('nessy-general-agent');
    expect(result.clientSecret).toBeUndefined();
    expect(result.authUrl).toContain('client_id=nessy-general-agent');
    expect(result.provider).toBe('mcp');
  });

  it('keeps the dynamically registered client when registration succeeds', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response(JSON.stringify({
          client_id: 'dynamic-client',
          client_secret: 'secret-123',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('dynamic-client');
    expect(result.clientSecret).toBe('secret-123');
    expect(result.authUrl).toContain('client_id=dynamic-client');
    const registrationRequest = mockFetch.mock.calls.find(([url]) => (
      url === 'https://example.com/oauth/register'
    ));
    expect((registrationRequest?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a configured public client ID without dynamic registration', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', {
      callbackPort: 8914,
      clientId: 'ConfiguredMCP',
    });

    expect(result.clientId).toBe('ConfiguredMCP');
    expect(result.authUrl).toContain('client_id=ConfiguredMCP');
    expect(mockFetch.mock.calls.some(([url]) => url === 'https://example.com/oauth/register')).toBe(false);
  });

  it('throws on unexpected registration failures instead of silently falling back', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Server error', { status: 500 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await expect(prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 })).rejects.toThrow('Failed to register OAuth client: Server error');
  });

  it('rejects GitLab TCS when 401 has no discovery hint and well-known metadata is absent', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === 'https://gitlab.tcsbank.ru/api/v4/mcp'
        && (options?.method === 'HEAD' || options?.method === 'GET')) {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      if (url === 'https://gitlab.tcsbank.ru/api/v4/mcp' && options?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await expect(prepareMcpOAuth(
      'https://gitlab.tcsbank.ru/api/v4/mcp',
      { callbackPort: 8914 },
    )).rejects.toThrow('No OAuth metadata found');
    expect(mockFetch.mock.calls.some(([url]) => (
      String(url).includes('.well-known/oauth-authorization-server')
    ))).toBe(true);
    expect(mockFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
  });
});

// ============================================================
// Confidential-client token authentication (D5 regression, `717a4e039`).
// Figma's dynamic registration returns a CONFIDENTIAL client — its AS
// advertises only `client_secret_basic`/`client_secret_post`, never `'none'` —
// and before that fix neither the code exchange nor the refresh grant could
// send a secret at all. Every exchange came back
// `{"error":"Client secret is required"}` while the browser half of the flow
// looked perfect, and the failure was invisible because the RPC discarded it
// (fixed separately in `911bf10f6`). The negative controls below are the other
// half of the contract: a PUBLIC client must keep sending nothing extra.
// ============================================================

describe('confidential OAuth clients authenticate at the token endpoint', () => {
  const tokenEndpoint = 'https://auth.figma.test/oauth/token';
  const mcpUrl = 'https://mcp.figma.test/mcp';

  const tokenBodyOf = (url: string): URLSearchParams => {
    const call = mockFetch.mock.calls.find(([requestUrl]) => requestUrl === url);
    expect(call).toBeDefined();
    return new URLSearchParams(String((call?.[1] as RequestInit | undefined)?.body));
  };

  beforeEach(() => {
    mockFetch = mock((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://mcp.figma.test/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.figma.test/oauth/authorize',
          token_endpoint: tokenEndpoint,
        }), { status: 200 }));
      }
      if (url === tokenEndpoint && options?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'access-confidential',
          refresh_token: 'refresh-confidential',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });
  });

  it('sends client_secret on the code exchange, and keeps PKCE intact', async () => {
    const exchanged = await exchangeMcpOAuth({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint,
      clientId: 'dynamic-client',
      redirectUri: 'http://127.0.0.1:8914/oauth/callback',
      clientSecret: 'secret-123',
    });

    expect(exchanged).toMatchObject({ success: true, accessToken: 'access-confidential' });
    const body = tokenBodyOf(tokenEndpoint);
    expect(body.get('client_secret')).toBe('secret-123');
    // `client_secret_post` (RFC 6749 §2.3.1) rides ALONGSIDE PKCE — it does not
    // replace it, so the verifier and the client id must still be on the wire.
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_id')).toBe('dynamic-client');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('sends no client_secret on the code exchange for a public client', async () => {
    const exchanged = await exchangeMcpOAuth({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint,
      clientId: 'nessy-general-agent',
      redirectUri: 'http://127.0.0.1:8914/oauth/callback',
    });

    expect(exchanged).toMatchObject({ success: true });
    expect(tokenBodyOf(tokenEndpoint).has('client_secret')).toBe(false);
  });

  it('sends client_secret on the refresh grant', async () => {
    const oauth = new NessyOAuth(
      { mcpUrl },
      { onStatus: () => {}, onError: () => {} },
    );

    const tokens = await withTestNetwork(() => oauth.refreshAccessToken(
      'refresh-1',
      'dynamic-client',
      'secret-123',
    ));

    expect(tokens.accessToken).toBe('access-confidential');
    const body = tokenBodyOf(tokenEndpoint);
    expect(body.get('client_secret')).toBe('secret-123');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('sends no client_secret on the refresh grant for a public client', async () => {
    const oauth = new NessyOAuth(
      { mcpUrl },
      { onStatus: () => {}, onError: () => {} },
    );

    await withTestNetwork(() => oauth.refreshAccessToken('refresh-1', 'nessy-general-agent'));

    expect(tokenBodyOf(tokenEndpoint).has('client_secret')).toBe(false);
  });
});

// ============================================================
// UB3.3 (R14-18, upstream v0.13.6 / OSS #1054, unchanged through v0.15.1) —
// the RFC 8707 resource indicator: discovery carries the PRM-declared
// `resource`, and authorize / token / refresh send it. The explicit
// `oauthResource` override keeps winning; nothing derived is sent on the wire.
// ============================================================

describe('UB3.3 — RFC 8707 resource indicator', () => {
  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
  });

  /** Mocks a resource-bound topology: 401 + hint → PRM → auth server metadata. */
  function mockResourceBoundServer(fetchMock: ReturnType<typeof mock>, prmResource = 'https://notfair.co/api/mcp/notfair') {
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url === 'https://notfair.co/api/mcp/notfair' && options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer resource_metadata="https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair"',
          },
        }));
      }
      if (url === 'https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair') {
        return Promise.resolve(new Response(JSON.stringify({
          resource: prmResource,
          authorization_servers: ['https://notfair.co'],
        }), { status: 200 }));
      }
      if (url === 'https://notfair.co/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://notfair.co/api/oauth/authorize',
          token_endpoint: 'https://notfair.co/api/oauth/token',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });
  }

  it('positive: the PRM-declared resource is sent on the authorization request and carried on the flow', async () => {
    mockResourceBoundServer(mockFetch);

    const prepared = await prepareMcpOAuth('https://notfair.co/api/mcp/notfair', { callbackPort: 8914 });

    expect(new URL(prepared.authUrl).searchParams.get('resource')).toBe('https://notfair.co/api/mcp/notfair');
    expect(prepared.oauthResource).toBe('https://notfair.co/api/mcp/notfair');
  });

  it('an explicit oauthResource override wins over the PRM-declared identifier', async () => {
    // The override is also the DISCOVERY target in ours (documented: an operator
    // pointing at an internal proxy), so the mock serves the override's own chain
    // — whose PRM declares a DIFFERENT canonical identifier — BESIDE the notfair
    // topology. The override must still win.
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === 'https://notfair.co/api/other' && options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer resource_metadata="https://notfair.co/.well-known/oauth-protected-resource/api/other"',
          },
        }));
      }
      if (url === 'https://notfair.co/.well-known/oauth-protected-resource/api/other') {
        return Promise.resolve(new Response(JSON.stringify({
          resource: 'https://notfair.co/other-canonical',
          authorization_servers: ['https://notfair.co'],
        }), { status: 200 }));
      }
      // The notfair topology's AS metadata is shared by both chains.
      if (url === 'https://notfair.co/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://notfair.co/api/oauth/authorize',
          token_endpoint: 'https://notfair.co/api/oauth/token',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const prepared = await prepareMcpOAuth('https://notfair.co/api/mcp/notfair', {
      callbackPort: 8914,
      oauthResource: 'https://notfair.co/api/other',
    });

    expect(new URL(prepared.authUrl).searchParams.get('resource')).toBe('https://notfair.co/api/other');
    expect(prepared.oauthResource).toBe('https://notfair.co/api/other');
  });

  it('omits resource when only RFC 8414 discovery succeeds (no PRM — server may not support RFC 8707)', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const prepared = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    // No PRM → no declared resource → no derived fallback, which would break
    // servers (e.g. Azure v1) that reject unexpected `resource` parameters.
    expect(prepared.oauthResource).toBeUndefined();
    expect(new URL(prepared.authUrl).searchParams.has('resource')).toBe(false);
  });

  it('positive: the resource is repeated on the token exchange (RFC 8707 §2.2)', async () => {
    let tokenBody: string | undefined;
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === 'https://notfair.co/api/oauth/token') {
        tokenBody = options?.body as string;
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'scoped-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await exchangeMcpOAuth({
      code: 'auth-code',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://notfair.co/api/oauth/token',
      clientId: 'nessy-general-agent',
      redirectUri: 'http://localhost:8914/callback',
      oauthResource: 'https://notfair.co/api/mcp/notfair',
    });

    expect(result.success).toBe(true);
    expect(new URLSearchParams(tokenBody!).get('resource')).toBe('https://notfair.co/api/mcp/notfair');
  });

  it('control: an invalid_target answer retries the exchange once without the resource and succeeds', async () => {
    const tokenBodies: string[] = [];
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      const body = options?.body as string;
      tokenBodies.push(body);
      return Promise.resolve(
        new URLSearchParams(body).has('resource')
          ? new Response(JSON.stringify({ error: 'invalid_target', error_description: 'unknown resource' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ access_token: 'legacy-token', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });

    const result = await exchangeMcpOAuth({
      code: 'auth-code',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://legacy.example.com/token',
      clientId: 'nessy-general-agent',
      redirectUri: 'http://localhost:8914/callback',
      oauthResource: 'https://legacy.example.com/mcp',
    });

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe('legacy-token');
    expect(tokenBodies).toHaveLength(2);
    expect(new URLSearchParams(tokenBodies[0]!).get('resource')).toBe('https://legacy.example.com/mcp');
    expect(new URLSearchParams(tokenBodies[1]!).has('resource')).toBe(false);
    // Everything else is repeated verbatim.
    expect(new URLSearchParams(tokenBodies[1]!).get('code_verifier')).toBe('verifier');
  });

  it('control: other token errors and a resource-less request are never retried', async () => {
    const tokenBodies: string[] = [];
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      tokenBodies.push(options?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    });

    const otherError = await exchangeMcpOAuth({
      code: 'auth-code',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://legacy.example.com/token',
      clientId: 'nessy-general-agent',
      redirectUri: 'http://localhost:8914/callback',
      oauthResource: 'https://legacy.example.com/mcp',
    });
    expect(otherError.success).toBe(false);
    expect((otherError as { error?: string }).error).toContain('invalid_grant');
    expect(tokenBodies).toHaveLength(1);

    const noResource = await exchangeMcpOAuth({
      code: 'auth-code',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://legacy.example.com/token',
      clientId: 'nessy-general-agent',
      redirectUri: 'http://localhost:8914/callback',
    });
    expect(noResource.success).toBe(false);
    expect(tokenBodies).toHaveLength(2);
    expect(new URLSearchParams(tokenBodies[1]!).has('resource')).toBe(false);
  });

  it('positive: the refresh grant repeats the PRM-declared resource', async () => {
    const tokenBodies: string[] = [];
    // Discovery topology + the token endpoint in one mock.
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === 'https://notfair.co/api/oauth/token') {
        tokenBodies.push(options?.body as string);
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'refreshed-scoped', token_type: 'Bearer', expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url === 'https://notfair.co/api/mcp/notfair' && options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair"' },
        }));
      }
      if (url === 'https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair') {
        return Promise.resolve(new Response(JSON.stringify({
          resource: 'https://notfair.co/api/mcp/notfair',
          authorization_servers: ['https://notfair.co'],
        }), { status: 200 }));
      }
      if (url === 'https://notfair.co/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://notfair.co/api/oauth/authorize',
          token_endpoint: 'https://notfair.co/api/oauth/token',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const oauth = new NessyOAuth(
      { mcpUrl: 'https://notfair.co/api/mcp/notfair' },
      { onStatus: () => {}, onError: () => {} },
    );
    const tokens = await withTestNetwork(() => oauth.refreshAccessToken('refresh-1', 'nessy-general-agent'));

    expect(tokens.accessToken).toBe('refreshed-scoped');
    expect(tokenBodies).toHaveLength(1);
    expect(new URLSearchParams(tokenBodies[0]!).get('resource')).toBe('https://notfair.co/api/mcp/notfair');
    expect(new URLSearchParams(tokenBodies[0]!).get('grant_type')).toBe('refresh_token');
  });

  it('control: the refresh grant sends no resource when no PRM declared one', async () => {
    let refreshBody: string | undefined;
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://legacy.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://legacy.example.com/authorize',
          token_endpoint: 'https://legacy.example.com/token',
        }), { status: 200 }));
      }
      if (url === 'https://legacy.example.com/token') {
        refreshBody = options?.body as string;
        return Promise.resolve(new Response(JSON.stringify({
          access_token: 'refreshed-token', token_type: 'Bearer', expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const oauth = new NessyOAuth(
      { mcpUrl: 'https://legacy.example.com/mcp' },
      { onStatus: () => {}, onError: () => {} },
    );
    const tokens = await withTestNetwork(() => oauth.refreshAccessToken('refresh-1', 'nessy-general-agent'));

    expect(tokens.accessToken).toBe('refreshed-token');
    expect(new URLSearchParams(refreshBody!).has('resource')).toBe(false);
    expect(new URLSearchParams(refreshBody!).get('grant_type')).toBe('refresh_token');
  });

  describe('canonicalResourceIdentifier', () => {
    it('keeps the path, drops the fragment, strips the query, and normalizes the bare root', () => {
      expect(canonicalResourceIdentifier('https://notfair.co/api/mcp/notfair'))
        .toBe('https://notfair.co/api/mcp/notfair');
      expect(canonicalResourceIdentifier('https://example.com/mcp#frag'))
        .toBe('https://example.com/mcp');
      expect(canonicalResourceIdentifier('https://example.com/')).toBe('https://example.com');
      expect(canonicalResourceIdentifier('https://example.com/mcp?tenant=acme'))
        .toBe('https://example.com/mcp');
      expect(canonicalResourceIdentifier('not a url')).toBeUndefined();
    });
  });
});
