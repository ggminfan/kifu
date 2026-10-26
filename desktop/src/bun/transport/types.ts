import type { AgentKind } from '../../../../src/shared/agents';
import type { AgentDiscovery, AgentScan } from '../../../../src/shared/remote-protocol';
import type { HostKeyPrompt } from '../ssh/hostkey';
import type { ServerEndpoint } from './server-process';

/**
 * What the app layer sees of a connection (本机 or an SSH host) and of the
 * servers it runs: one per agent (Codex, Claude Code), each serving all of
 * that agent's sessions on the machine. Both connection kinds implement the
 * same shape.
 */

/** Which server: the agent, and the directories its homes are found under. */
export interface ServerSpec {
  agent: AgentKind;
  roots?: string[];
}

export type HostStatus = 'idle' | 'connecting' | 'hostkey' | 'installing' | 'ready' | 'reconnecting' | 'error';
export type ServerStatus = 'starting' | 'ready' | 'restarting' | 'error' | 'stopped';

export type StageId = 'config' | 'connect' | 'hostkey' | 'platform' | 'install' | 'server';
export type StageStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** One step of the connection flow, shown as a checklist. */
export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  message?: string;
}

export interface Step {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface HostError {
  kind: string;
  message: string;
  detail?: string;
}

export interface ManagedServer {
  readonly agent: AgentKind;
  readonly status: ServerStatus;
  readonly error?: string;
  readonly endpoint?: ServerEndpoint;
  /** Shown next to the home, e.g. "TCP 端口转发（远端禁止 socket 转发）". */
  readonly note?: string;
  start(): Promise<ServerEndpoint>;
  stop(): Promise<void>;
  /** The server came back (new process / new tunnel): windows must re-authenticate. */
  onRestart(cb: (ep: ServerEndpoint) => void): void;
  /** Synchronous best effort when the app is exiting. */
  kill(): void;
}

export interface HostRuntime {
  readonly kind: 'local' | 'ssh';
  readonly label: string;
  readonly status: HostStatus;
  readonly error?: HostError;
  readonly hostKey?: HostKeyPrompt;
  readonly progress?: { label: string; done: number; total: number };
  readonly steps: Step[];
  /** Connection flow (remotes only; empty for 本机). */
  readonly stages: Stage[];
  /** e.g. "dev@10.0.0.1:22 · via ProxyCommand · Linux x86_64 · glibc 2.31" */
  readonly detail?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  answerHostKey(accept: boolean): void;
  /** What this machine has of the agents asked for, each under its own scan directories. */
  discover(scan: AgentScan): Promise<AgentDiscovery[]>;
  /** The server for one agent (created on first use; one per agent). */
  server(spec: ServerSpec): ManagedServer;
  servers(): ManagedServer[];
  onChange(cb: () => void): void;
  killAll(): void;
}

export class Emitter {
  private handlers: Array<() => void> = [];
  on(cb: () => void): void {
    this.handlers.push(cb);
  }
  emit(): void {
    for (const h of this.handlers) {
      try {
        h();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class StepLog {
  readonly steps: Step[] = [];
  constructor(
    private readonly changed: () => void,
    private readonly log: (line: string) => void = () => {},
    private readonly max = 60,
  ) {}
  add(text: string, level: Step['level'] = 'info'): void {
    this.steps.push({ at: Date.now(), level, text });
    if (this.steps.length > this.max) this.steps.splice(0, this.steps.length - this.max);
    this.log(`[${level}] ${text}`);
    this.changed();
  }
}
