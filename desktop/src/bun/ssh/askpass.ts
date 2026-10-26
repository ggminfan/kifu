import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { shQuote } from './args';
import { validateSecret } from '../../shared/ssh';

/** A short-lived private socket supplies one credential to OpenSSH's askpass.
 * The executable files contain no credential; argv/env only carry IPC routing.
 */
export async function createAskpass(value: string): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  let secret = validateSecret(value);
  if (!secret) throw new Error('请输入密码或密钥口令');
  const dir = fs.mkdtempSync('/tmp/kifu-auth-');
  fs.chmodSync(dir, 0o700);
  const socketPath = `${dir}/socket`;
  const nonce = randomBytes(32).toString('hex');
  const sockets = new Set<net.Socket>();
  let answered = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(2500, () => socket.destroy());
    let input = '';
    let replied = false;
    socket.on('data', (chunk) => {
      if (replied) return;
      input += chunk.toString();
      if (input.length > 8192) return socket.destroy();
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input.split('\n')[0]);
        if (request.nonce !== nonce || typeof request.prompt !== 'string' || !/password|passphrase/i.test(request.prompt) || answered >= 3 || secret === undefined) return socket.destroy();
        answered++;
        replied = true;
        socket.end(JSON.stringify({ secret }) + '\n');
      } catch { socket.destroy(); }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(`${dir}/client.cjs`, `const net = require('node:net');
const c = net.connect(process.env.KIFU_AUTH_SOCKET);
let data = '';
c.setTimeout(3000, () => c.destroy());
c.on('connect', () => c.write(JSON.stringify({ nonce: process.env.KIFU_AUTH_NONCE, prompt: process.argv[2] }) + '\\n'));
c.on('data', b => { data += b; if (data.length > 16384) c.destroy(); });
c.on('error', () => { process.exitCode = 1; });
c.on('close', () => { try { const r = JSON.parse(data); if (typeof r.secret !== 'string') throw 0; process.stdout.write(r.secret + '\\n'); } catch { process.exitCode = 1; } });
`, { mode: 0o600 });
    fs.writeFileSync(`${dir}/askpass`, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(`${dir}/client.cjs`)} "$@"\n`, { mode: 0o700 });
  } catch (error) {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    env: { ...process.env, SSH_ASKPASS: `${dir}/askpass`, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'kifu:0', KIFU_AUTH_SOCKET: socketPath, KIFU_AUTH_NONCE: nonce },
    async close() {
      if (closed) return;
      closed = true;
      secret = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
