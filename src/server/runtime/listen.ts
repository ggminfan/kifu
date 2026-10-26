import fs from 'node:fs';

/**
 * HTTP listener that works under both runtimes: Bun.serve (desktop + remote
 * binaries) and @hono/node-server (pnpm dev). Supports TCP or a Unix socket.
 */

export type FetchHandler = (req: Request) => Response | Promise<Response>;

export interface ListenOptions {
  fetch: FetchHandler;
  host?: string;
  port?: number;
  socket?: string;
}

export interface Listener {
  host?: string;
  port?: number;
  socket?: string;
  close(): Promise<void>;
}

interface BunServer {
  port: number;
  stop(force?: boolean): void;
}

interface BunGlobal {
  serve(opts: Record<string, unknown>): BunServer;
}

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

export async function listen(o: ListenOptions): Promise<Listener> {
  if (o.socket) {
    try {
      fs.unlinkSync(o.socket);
    } catch {
      // no stale socket
    }
  }
  if (isBun) {
    const Bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;
    const server = Bun.serve({
      fetch: o.fetch,
      // SSE and slow handlers must not be cut by Bun's 10s default.
      idleTimeout: 0,
      ...(o.socket ? { unix: o.socket } : { hostname: o.host ?? '127.0.0.1', port: o.port ?? 0 }),
    });
    if (o.socket) fs.chmodSync(o.socket, 0o600);
    return {
      host: o.socket ? undefined : (o.host ?? '127.0.0.1'),
      port: o.socket ? undefined : server.port,
      socket: o.socket,
      close: async () => server.stop(true),
    };
  }
  const { createAdaptorServer } = await import('@hono/node-server');
  const server = createAdaptorServer({ fetch: o.fetch });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (o.socket) server.listen(o.socket, () => resolve());
    else server.listen(o.port ?? 0, o.host ?? '127.0.0.1', () => resolve());
  });
  if (o.socket) fs.chmodSync(o.socket, 0o600);
  const addr = server.address();
  return {
    host: o.socket ? undefined : (o.host ?? '127.0.0.1'),
    port: typeof addr === 'object' && addr ? addr.port : undefined,
    socket: o.socket,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
