// Worker bootstrap: register the tsx loader so the worker can run TypeScript, then load the real entry.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
