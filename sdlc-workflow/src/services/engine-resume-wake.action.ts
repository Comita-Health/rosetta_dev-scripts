import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IProcessDetachRepository } from '../repositories/process-detach.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  readSuperviseLaunchRecord,
  type SuperviseLaunchRecord
} from '../utils/launch-record';
import type { IChronicleCommitService } from './chronicle-commit.service';
import type {
  IWakeAction,
  WakeActionContext,
  WakeActionResult
} from './wake-action';

export const ENGINE_RESUME_WAKE_ACTION_ID = 'engine-resume';

const RESUME_SIGNALS = new Set(['merged', 'closed']);

const textField = (
  data: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  if (data === undefined) {
    return undefined;
  }
  const value = data[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
};

const signalName = (wake: WakeActionContext['wake']): string | undefined => {
  const fromData = textField(wake.data, 'signal');
  if (fromData !== undefined) {
    return fromData;
  }
  const id = wake.signal;
  const colon = id.indexOf(':');
  if (colon > 0) {
    return id.slice(0, colon);
  }
  return id.length > 0 ? id : undefined;
};

const readPid = (runDir: string): number | null => {
  const pidPath = path.join(runDir, 'supervise.pid');
  if (!existsSync(pidPath)) {
    return null;
  }
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/**
 * Headless resume on blocker-close / out-of-band PR merge wakes.
 *
 * @remarks
 * No-ops unless the wake carries a `merged`/`closed` signal and a `runId`
 * (usually from watch `resumeContext`). Idempotent when supervise is already
 * alive. On `merged`, records the merge SHA when the task is still open, then
 * relaunches `--supervise` from `launch.json`.
 */
@injectable()
export class EngineResumeWakeAction implements IWakeAction {
  readonly id = ENGINE_RESUME_WAKE_ACTION_ID;

  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.ChronicleCommitService)
    private readonly _chronicle: IChronicleCommitService,
    @inject(WORKFLOW_TOKENS.ProcessDetachRepository)
    private readonly _detachRepo: IProcessDetachRepository
  ) {}

  async execute(context: WakeActionContext): Promise<WakeActionResult> {
    const signal = signalName(context.wake);
    if (signal === undefined || RESUME_SIGNALS.has(signal) === false) {
      return { ok: true };
    }
    const runId = textField(context.wake.data, 'runId');
    if (runId === undefined) {
      return { ok: true };
    }

    let runsDir: string;
    try {
      const { config } = this._configRepo.load(context.workspaceRoot);
      runsDir = textField(context.wake.data, 'runsDir') ?? config.runsDir;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'failed to load daemon config for resume'
      };
    }

    const runDir = path.join(runsDir, runId);
    const existingPid = readPid(runDir);
    if (existingPid !== null && this._detachRepo.isAlive(existingPid)) {
      return { ok: true };
    }

    if (signal === 'merged') {
      const mergeError = await this.recordMergeIfNeeded(
        context,
        runsDir,
        runId
      );
      if (mergeError !== undefined) {
        return { ok: false, error: mergeError };
      }
    }

    const launch = readSuperviseLaunchRecord(runsDir, runId);
    if (launch === null) {
      return {
        ok: false,
        error: `no launch.json for run ${runId} — cannot headless-resume`
      };
    }

    try {
      this.relaunch(launch, runDir);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : `failed to relaunch supervise for ${runId}`
      };
    }
  }

  private async recordMergeIfNeeded(
    context: WakeActionContext,
    runsDir: string,
    runId: string
  ): Promise<string | undefined> {
    const taskId = textField(context.wake.data, 'taskId');
    const mergeCommitOid = textField(context.wake.data, 'mergeCommitOid');
    if (taskId === undefined || mergeCommitOid === undefined) {
      // Issue-close path uses signal closed; merged without SHA is still a
      // relaunch cue (operator fixed gates / squash already recorded).
      return undefined;
    }
    const state = this._runStateRepo.load(runsDir, runId);
    if (state === null) {
      return `run ${runId} has no state.json — cannot record-merge`;
    }
    const already = state.taskResults[taskId]?.mergedSha;
    if (typeof already === 'string' && already.length > 0) {
      return undefined;
    }
    const chronicleRepo =
      textField(context.wake.data, 'chronicleRepo') ??
      readSuperviseLaunchRecord(runsDir, runId)?.chronicleRepo;
    if (chronicleRepo === undefined || chronicleRepo.length === 0) {
      // Still mark local state so dependents unlock even without Chronicle.
      this._runStateRepo.recordMergedSha(runsDir, state, mergeCommitOid);
      this._runStateRepo.recordTaskMerged(
        runsDir,
        state,
        taskId,
        mergeCommitOid
      );
      return undefined;
    }
    try {
      await this._chronicle.recordMerge({
        chronicleRepo,
        runsDir,
        runId,
        mergedSha: mergeCommitOid,
        taskId,
        approvedBy: 'out-of-band'
      });
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : `record-merge failed for ${runId}/${taskId}`;
    }
  }

  private relaunch(launch: SuperviseLaunchRecord, runDir: string): void {
    if (launch.argv.length === 0) {
      throw new Error('launch.json has empty argv');
    }
    mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'supervise.log');
    const monitorPath = path.join(runDir, 'monitor.log');
    const { pid } = this._detachRepo.spawnDetached({
      command: launch.execPath,
      args: [...launch.execArgv, ...launch.argv],
      cwd: launch.cwd,
      logPath,
      env: {
        ...process.env,
        SDLC_SUPERVISE_MONITOR: monitorPath
      }
    });
    writeFileSync(path.join(runDir, 'supervise.pid'), `${pid}\n`);
  }
}
