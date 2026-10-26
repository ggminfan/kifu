/**
 * One queue for everything that runs an agent CLI with the user's model quota
 * (Skill Lab runs, replays, later batch evaluations): at most `limit` at once,
 * interactive work (someone is waiting on the page) before batch work.
 */

export type Lane = 'interactive' | 'batch';

export interface Job {
  id: string;
  lane: Lane;
  start: () => Promise<void>;
}

const queue: Job[] = [];
const active = new Set<string>();
let limit = Math.max(1, Number(process.env.KIFU_EXEC_CONCURRENCY ?? 2) || 2);

export function setConcurrency(n: number): void {
  limit = Math.max(1, Math.floor(n));
  pump();
}

export function enqueue(job: Job): void {
  queue.push(job);
  pump();
}

/** Take a job out of the queue before it starts; false if it already started (or never existed). */
export function dequeue(id: string): boolean {
  const i = queue.findIndex((j) => j.id === id);
  if (i === -1) return false;
  queue.splice(i, 1);
  return true;
}

/** 1-based position among the waiting jobs (interactive ones count first), 0 when not waiting. */
export function queuePosition(id: string): number {
  const order = [...queue.filter((j) => j.lane === 'interactive'), ...queue.filter((j) => j.lane === 'batch')];
  return order.findIndex((j) => j.id === id) + 1;
}

/** Waiting or running. */
export function isPending(id: string): boolean {
  return active.has(id) || queue.some((j) => j.id === id);
}

export function queueBusy(): boolean {
  return active.size > 0 || queue.length > 0;
}

export function clearQueue(): void {
  queue.length = 0;
}

function next(): Job | undefined {
  const i = queue.findIndex((j) => j.lane === 'interactive');
  return queue.splice(i === -1 ? 0 : i, 1)[0];
}

function pump(): void {
  while (active.size < limit && queue.length) {
    const job = next()!;
    active.add(job.id);
    void job
      .start()
      .catch(() => undefined)
      .finally(() => {
        active.delete(job.id);
        pump();
      });
  }
}
