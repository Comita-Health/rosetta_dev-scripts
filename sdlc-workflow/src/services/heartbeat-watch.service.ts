import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs';
import { injectable } from 'inversify';
import path from 'path';

export interface HeartbeatWatchStartInput {
  /** Path to `<runsDir>/<runId>/heartbeat.jsonl`. */
  heartbeatPath: string;
  /** Operator live feed (e.g. `/tmp/<runId>-monitor.log` or under runsDir). */
  monitorPath: string;
  /** Poll interval for new heartbeat lines (ms). Default 1000. */
  pollMs?: number;
}

/**
 * Mirrors new `heartbeat.jsonl` lines into a monitor log so operators and
 * supervising agents can `tail -f` one file without blocking the chat on
 * sandbox/CI waits (operator-background-supervise / #39 companion).
 */
export interface IHeartbeatWatchService {
  start(input: HeartbeatWatchStartInput): void;
  stop(): void;
  /** Append a non-heartbeat operator line to the monitor log. */
  note(monitorPath: string, message: string): void;
}

@injectable()
export class HeartbeatWatchService implements IHeartbeatWatchService {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _offset = 0;
  private _heartbeatPath = '';
  private _monitorPath = '';
  private _count = 0;

  start(input: HeartbeatWatchStartInput): void {
    this.stop();
    this._heartbeatPath = input.heartbeatPath;
    this._monitorPath = input.monitorPath;
    this._offset = 0;
    this._count = 0;
    mkdirSync(path.dirname(input.monitorPath), { recursive: true });
    this.note(
      input.monitorPath,
      `[hb-watch] started ${new Date().toISOString()}`
    );
    const pollMs = input.pollMs ?? 1000;
    this._timer = setInterval(() => this.poll(), pollMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
    this.poll();
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Clear path so a stray poll after stop cannot write; monitor path is
    // kept only long enough for the supervise finally-note (call note first).
    this._heartbeatPath = '';
  }

  note(monitorPath: string, message: string): void {
    mkdirSync(path.dirname(monitorPath), { recursive: true });
    appendFileSync(monitorPath, `${message}\n`);
  }

  private poll(): void {
    if (this._heartbeatPath.length === 0) {
      return;
    }
    if (!existsSync(this._heartbeatPath)) {
      return;
    }
    const size = statSync(this._heartbeatPath).size;
    if (size < this._offset) {
      this._offset = 0;
    }
    if (size === this._offset) {
      return;
    }
    const buf = readFileSync(this._heartbeatPath);
    const chunk = buf.subarray(this._offset).toString('utf8');
    this._offset = size;
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      this._count += 1;
      const ts = new Date().toISOString();
      appendFileSync(this._monitorPath, `[hb #${this._count} ${ts}] ${line}\n`);
      writeFileSync(`${this._monitorPath}.count`, String(this._count));
    }
  }
}
