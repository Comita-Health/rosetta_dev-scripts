import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { GateVerdict, RunState, TaskRunResult } from '../types';

/**
 * Persists run state as JSON under `<runsDir>/<runId>/state.json` so a
 * killed run can resume (SPEC-PRD-0011-P2 T-01; the full cached step graph
 * is T-09).
 */
export interface IRunStateRepository {
  load(runsDir: string, runId: string): RunState | null;
  save(runsDir: string, state: RunState): string;
  appendVerdict(runsDir: string, state: RunState, verdict: GateVerdict): void;
  recordTaskResult(
    runsDir: string,
    state: RunState,
    result: TaskRunResult
  ): void;
}

const stateFile = (runsDir: string, runId: string): string =>
  path.join(runsDir, runId, 'state.json');

@injectable()
export class RunStateRepository implements IRunStateRepository {
  load(runsDir: string, runId: string): RunState | null {
    const file = stateFile(runsDir, runId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as RunState;
  }

  save(runsDir: string, state: RunState): string {
    const file = stateFile(runsDir, state.runId);
    mkdirSync(path.dirname(file), { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(state, null, 2));
    return file;
  }

  appendVerdict(runsDir: string, state: RunState, verdict: GateVerdict): void {
    state.verdicts.push(verdict);
    this.save(runsDir, state);
  }

  recordTaskResult(
    runsDir: string,
    state: RunState,
    result: TaskRunResult
  ): void {
    state.taskResults[result.taskId] = result;
    this.save(runsDir, state);
  }
}
