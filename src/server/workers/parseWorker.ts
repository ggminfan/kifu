import { parentPort } from 'node:worker_threads';
import { parseSession } from '../../core/parse';

interface ParseRequest {
  id: number;
  path: string;
  homeDir: string;
  prefixEnd?: number;
}

parentPort!.on('message', async (msg: ParseRequest) => {
  try {
    const result = await parseSession(msg.path, { homeDir: msg.homeDir, prefixEnd: msg.prefixEnd });
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
});
