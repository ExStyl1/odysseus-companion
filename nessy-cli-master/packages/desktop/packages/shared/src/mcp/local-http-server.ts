import { createServer, type Server as HttpServer } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// [nessy-fork] desktop-workspace-file-control
export class LocalMcpHttpServer {
  private readonly server: McpServer;
  private httpServer: HttpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private port = 0;

  constructor(server: McpServer) {
    this.server = server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<string> {
    if (this.httpServer) return this.url;

    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await this.server.connect(this.transport);

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      await this.transport!.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const address = this.httpServer!.address();
        this.port =
          typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  async stop(): Promise<void> {
    await this.transport?.close().catch(() => {});
    await this.server.close().catch(() => {});
    if (this.httpServer) {
      await new Promise<void>((resolve) =>
        this.httpServer!.close(() => resolve()),
      );
    }
    this.transport = null;
    this.httpServer = null;
    this.port = 0;
  }
}
