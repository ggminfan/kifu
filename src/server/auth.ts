import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

/**
 * Per-launch authentication for a kifu-server.
 *
 * - The desktop shell holds the long-lived token (received by the server on
 *   stdin) and calls the server with `Authorization: Bearer <token>`.
 * - Windows never see the token: the shell mints a single-use nonce
 *   (POST /__kifu/nonce, Bearer) and opens /__kifu_auth?n=<nonce>&next=/…, which
 *   sets an HttpOnly, SameSite=Strict session cookie named per instance (all
 *   windows share one cookie store, and cookies don't separate ports).
 * - Every path is checked; comparisons hash both sides and use timingSafeEqual.
 * - Without a token (pnpm dev) only the localhost / CSRF guards apply.
 */

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function safeEqual(candidate: string | undefined, digest: Buffer | undefined): boolean {
  if (!candidate || !digest) return false;
  return timingSafeEqual(sha256(candidate), digest);
}

const NONCE_TTL = 60_000;

export class Auth {
  private tokenDigest?: Buffer;
  private sessionSecret = randomBytes(32).toString('base64url');
  private sessionDigest = sha256(this.sessionSecret);
  private readonly nonces = new Map<string, number>();

  constructor(
    token: string | undefined,
    readonly instanceId: string,
  ) {
    this.tokenDigest = token ? sha256(token) : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.tokenDigest);
  }

  /**
   * A new client (the desktop app after a restart) takes over: only the new
   * token works from now on, and window sessions of the old client end.
   */
  rekey(token: string): void {
    this.tokenDigest = sha256(token);
    this.sessionSecret = randomBytes(32).toString('base64url');
    this.sessionDigest = sha256(this.sessionSecret);
    this.nonces.clear();
  }

  get cookieName(): string {
    return `kifu_${this.instanceId}`;
  }

  checkToken(t: string | undefined): boolean {
    return safeEqual(t, this.tokenDigest);
  }

  checkSession(v: string | undefined): boolean {
    return safeEqual(v, this.sessionDigest);
  }

  mintNonce(): string {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    const n = randomBytes(24).toString('base64url');
    this.nonces.set(n, now + NONCE_TTL);
    return n;
  }

  consumeNonce(n: string): boolean {
    const exp = this.nonces.get(n);
    this.nonces.delete(n);
    return exp !== undefined && exp > Date.now();
  }

  /** The cookie value handed to windows after a successful nonce exchange. */
  sessionValue(): string {
    return this.sessionSecret;
  }
}

/** The shell's token: `Authorization: Bearer`. */
function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const UNAUTHORIZED_PAGE = `<!doctype html><meta charset="utf-8"><title>未认证</title>
<body style="font:14px system-ui;padding:40px;color:#444">
<h3>未认证</h3><p>这个 Kifu 服务需要通过桌面客户端打开（每次启动的凭证都不同）。</p></body>`;

export function authMiddleware(auth: Auth, onActivity?: () => void): MiddlewareHandler {
  return async (c, next) => {
    onActivity?.();
    const url = new URL(c.req.url);
    const host = c.req.header('host') ?? '';
    if (!LOCAL_HOST.test(host)) return c.text('forbidden host', 403);

    if (url.pathname === '/__kifu/nonce') {
      if (c.req.method !== 'POST' || !auth.checkToken(bearer(c))) return c.json({ error: 'unauthorized' }, 401);
      return c.json({ nonce: auth.mintNonce() });
    }

    if (url.pathname === '/__kifu_auth') {
      let next = url.searchParams.get('next') ?? '/';
      if (!next.startsWith('/') || next.startsWith('//')) next = '/';
      if (!auth.enabled) return c.redirect(next, 302);
      if (!auth.consumeNonce(url.searchParams.get('n') ?? '')) return c.html(UNAUTHORIZED_PAGE, 401);
      setCookie(c, auth.cookieName, auth.sessionValue(), { httpOnly: true, sameSite: 'Strict', path: '/' });
      return c.redirect(next, 302);
    }

    const viaToken = auth.checkToken(bearer(c));
    if (auth.enabled && !viaToken && !auth.checkSession(getCookie(c, auth.cookieName))) {
      // lets a proxy in front tell our 401 from its gateway's
      c.header('X-Kifu-Server', '1');
      const wantsHtml = c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html');
      return wantsHtml ? c.html(UNAUTHORIZED_PAGE, 401) : c.json({ error: 'unauthorized' }, 401);
    }

    // CSRF / cross-instance guards (cookies are shared across all local ports).
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && !viaToken) {
      if (c.req.header('x-kifu') !== '1') return c.json({ error: 'missing X-Kifu header' }, 403);
      const origin = c.req.header('origin');
      if (origin && origin !== `http://${host}`) return c.json({ error: 'bad origin' }, 403);
    }
    const site = c.req.header('sec-fetch-site');
    if ((site === 'cross-site' || site === 'same-site') && c.req.header('sec-fetch-mode') !== 'navigate') {
      return c.json({ error: 'cross-site request' }, 403);
    }
    await next();
  };
}
