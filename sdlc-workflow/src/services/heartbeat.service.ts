import { execSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IGitRepository } from '../repositories/git.repository';
import { WORKFLOW_TOKENS } from '../tokens';

/** Structured progress line for operators and supervising agents (#39). */
export interface HeartbeatSnapshot {
  ts: string;
  runId: string;
  taskId?: string;
  step: string;
  stepElapsedMs: number;
  agentAlive: boolean;
  worktreeDirty: boolean;
  worktreeHead?: string;
  lastLine?: string;
}

export interface HeartbeatContext {
  taskId?: string;
  step: string;
  worktreePath?: string;
  lastLine?: string;
}

export interface HeartbeatStartInput {
  runId: string;
  runsDir: string;
  /** Interval in milliseconds; values ≤ 0 disable the ticker. */
  intervalMs: number;
}

/**
 * Native progress heartbeat (#39): emits the same signals operators used to
 * shell-poll (alive, taskId, step, dirty/clean, last line) on an interval
 * to stdout and `<runsDir>/<runId>/heartbeat.jsonl`.
 */
export interface IHeartbeatService {
  start(input: HeartbeatStartInput): void;
  setContext(ctx: Partial<HeartbeatContext>): void;
  /** Emit one snapshot immediately (e.g. on step transitions). */
  tick(): void;
  stop(): void;
}

@injectable()
export class HeartbeatService implements IHeartbeatService {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _runId = '';
  private _runsDir = '';
  private _stepStartedAt = Date.now();
  private _ctx: HeartbeatContext = { step: 'idle' };

  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository
  ) {}

  start(input: HeartbeatStartInput): void {
    this.stop();
    if (input.intervalMs <= 0) return;
    this._runId = input.runId;
    this._runsDir = input.runsDir;
    this._stepStartedAt = Date.now();
    this._ctx = { step: 'starting' };
    this.tick();
    this._timer = setInterval(() => this.tick(), input.intervalMs);
    // Unref so the timer alone cannot keep a finished run alive.
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  setContext(ctx: Partial<HeartbeatContext>): void {
    const stepChanged = ctx.step !== undefined && ctx.step !== this._ctx.step;
    this._ctx = { ...this._ctx, ...ctx };
    if (stepChanged) {
      this._stepStartedAt = Date.now();
    }
  }

  tick(): void {
    if (this._runId.length === 0) return;
    const snapshot = this.buildSnapshot();
    const line = JSON.stringify(snapshot);
    console.log(`[heartbeat] ${line}`);
    const dir = path.join(this._runsDir, this._runId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'heartbeat.jsonl'), `${line}\n`);
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._runId = '';
  }

  private buildSnapshot(): HeartbeatSnapshot {
    const worktreePath = this._ctx.worktreePath;
    let worktreeDirty = false;
    let worktreeHead: string | undefined;
    if (worktreePath !== undefined && worktreePath.length > 0) {
      try {
        worktreeDirty = this._gitRepo.status(worktreePath).trim().length > 0;
        worktreeHead = this._gitRepo.headSha(worktreePath).slice(0, 12);
      } catch {
        worktreeDirty = false;
      }
    }
    return {
      ts: new Date().toISOString(),
      runId: this._runId,
      taskId: this._ctx.taskId,
      step: this._ctx.step,
      stepElapsedMs: Date.now() - this._stepStartedAt,
      agentAlive: isAgentAlive(),
      worktreeDirty,
      worktreeHead,
      lastLine: this._ctx.lastLine
    };
  }
}

const isAgentAlive = (): boolean => {
  try {
    const out = execSync('pgrep -lf cursor-agent || true', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
};
