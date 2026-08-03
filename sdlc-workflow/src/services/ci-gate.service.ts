import { inject, injectable } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type {
  CheckRunSummary,
  ICiStatusRepository
} from '../repositories/ci-status.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, RunState, SpecTask } from '../types';
import { agentSpendK } from '../utils/agent-spend';
import { buildCiFixPrompt } from '../utils/ci-fix-prompt';
import { inputsDigest } from '../utils/digest';

export interface CiMonitorInput {
  repoPath: string;
  /** Task worktree — fix agents run and commit here. */
  worktreePath: string;
  branch: string;
  sha: string;
  task: SpecTask;
  runsDir: string;
  state: RunState;
  /** Envelope budget — fix agents are skipped once spend exceeds it. */
  budgetK: number;
  /** Poll interval, default 30s. Injectable for tests. */
  pollIntervalMs?: number;
  /** Overall deadline for the monitor, default 15 minutes. */
  timeoutMs?: number;
}

/**
 * P3 T-03: live CI monitoring with a bounded fix cycle. Polls the pushed
 * branch's check runs until terminal (bounded timeout). On failure,
 * dispatches a fix agent in the task worktree with the failing check
 * output as context, pushes the committed fix, and re-polls — at most
 * {@link CI_FIX_ATTEMPT_LIMIT} attempts total, persisted in
 * `ciFixAttempts` so resume never resets the budget. The returned verdict
 * is the final post-cycle state, with the cycle transcript attached as
 * evidence. Shadow-honesty rules for unpushed branches carry over from
 * the phase-2 gate: no results → blocked, spelled out.
 */
export interface ICiGateService {
  monitor(input: CiMonitorInput): Promise<GateVerdict>;
}

export const CI_FIX_ATTEMPT_LIMIT = 3;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

@injectable()
export class CiGateService implements ICiGateService {
  constructor(
    @inject(WORKFLOW_TOKENS.CiStatusRepository)
    private readonly _ciStatusRepo: ICiStatusRepository,
    @inject(WORKFLOW_TOKENS.AgentRunnerRepository)
    private readonly _agentRepo: IAgentRunnerRepository,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  async monitor(input: CiMonitorInput): Promise<GateVerdict> {
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const taskId = input.task.id;
    const log: string[] = [];
    let sha = input.sha;

    const base = (): Omit<
      GateVerdict,
      'outcome' | 'wouldEscalate' | 'reasons'
    > => ({
      gate: 'ci',
      taskId,
      inputsDigest: inputsDigest({ gate: 'ci', sha }),
      transcript: log.join('\n'),
      recordedAt: new Date().toISOString()
    });

    for (;;) {
      const summary = await this.pollUntilTerminal(
        input.repoPath,
        sha,
        pollIntervalMs,
        deadline,
        log
      );

      if (summary === null) {
        return {
          ...base(),
          outcome: 'blocked',
          wouldEscalate: false,
          reasons: [
            `no CI results for ${sha} — branch not pushed or gh unavailable`
          ]
        };
      }
      if (summary.total === 0) {
        return {
          ...base(),
          outcome: 'blocked',
          wouldEscalate: false,
          reasons: [`commit ${sha} has no check runs`]
        };
      }
      if (summary.pending.length > 0) {
        // Deadline expired with runs still pending.
        return {
          ...base(),
          outcome: 'blocked',
          wouldEscalate: true,
          reasons: summary.pending.map(
            name => `check still pending at timeout: ${name}`
          )
        };
      }
      if (summary.failed.length === 0) {
        log.push(`${summary.total} check runs green for ${sha}`);
        return {
          ...base(),
          outcome: 'pass',
          wouldEscalate: false,
          reasons: [`${summary.total} check runs green for ${sha}`]
        };
      }

      // Failing checks: dispatch a fix agent, bounded by the attempt
      // budget and the envelope token budget (P3 T-06).
      const attemptsSoFar = input.state.ciFixAttempts[taskId] ?? 0;
      if (attemptsSoFar >= CI_FIX_ATTEMPT_LIMIT) {
        log.push(
          `fix budget exhausted (${attemptsSoFar}/${CI_FIX_ATTEMPT_LIMIT}) — halting for human triage`
        );
        return {
          ...base(),
          outcome: 'breach',
          wouldEscalate: true,
          reasons: [
            ...summary.failed.map(name => `check failed: ${name}`),
            `ci-fix attempts exhausted (${attemptsSoFar}/${CI_FIX_ATTEMPT_LIMIT})`
          ]
        };
      }

      if (input.state.tokenSpendK > input.budgetK) {
        log.push(
          `token budget exhausted (${input.state.tokenSpendK}k > ${input.budgetK}k) — skipping fix agent`
        );
        return {
          ...base(),
          outcome: 'breach',
          wouldEscalate: true,
          reasons: [
            ...summary.failed.map(name => `check failed: ${name}`),
            `budget exhausted: spend ${input.state.tokenSpendK}k exceeds budget ${input.budgetK}k`
          ]
        };
      }

      const attempt = this._runStateRepo.recordCiFixAttempt(
        input.runsDir,
        input.state,
        taskId
      );
      const failedLogs = this._ciStatusRepo.failedLogs(input.repoPath, sha);
      log.push(
        `attempt ${attempt}/${CI_FIX_ATTEMPT_LIMIT}: checks failed [${summary.failed.join(', ')}] — dispatching fix agent`
      );
      const prompt = buildCiFixPrompt(
        input.task,
        summary.failed,
        failedLogs,
        attempt,
        CI_FIX_ATTEMPT_LIMIT
      );
      try {
        await this._agentRepo.run(input.worktreePath, prompt);
        this._runStateRepo.recordTokenSpend(
          input.runsDir,
          input.state,
          agentSpendK()
        );
      } catch (err) {
        this._runStateRepo.recordTokenSpend(
          input.runsDir,
          input.state,
          agentSpendK()
        );
        log.push(
          `fix agent dispatch failed: ${err instanceof Error ? err.message : String(err)}`
        );
        continue; // consumes the attempt; re-poll the unchanged sha
      }

      let fixedSha = this._gitRepo.headSha(input.worktreePath);
      if (fixedSha === sha) {
        // #41: salvage a dirty worktree when husky blocked the agent commit.
        const dirty = this._gitRepo.status(input.worktreePath).trim();
        if (dirty.length > 0) {
          try {
            this._gitRepo.stageAll(input.worktreePath);
            this._gitRepo.commit(
              input.worktreePath,
              `fix(${input.task.id}): CI fix attempt ${attempt}`,
              { noVerify: true, signOff: true }
            );
            fixedSha = this._gitRepo.headSha(input.worktreePath);
            log.push(
              `engine committed dirty CI fix (--no-verify) on attempt ${attempt}`
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log.push(
              `fix agent produced no commit (attempt ${attempt}); engine commit failed: ${reason.slice(0, 200)}`
            );
            continue;
          }
        } else {
          log.push(`fix agent produced no commit (attempt ${attempt})`);
          continue; // attempt consumed; same sha will fail again or exhaust
        }
      }
      this._gitRepo.push(input.worktreePath, input.branch);
      log.push(`fix pushed: ${sha} -> ${fixedSha}`);
      sha = fixedSha;
    }
  }

  private async pollUntilTerminal(
    repoPath: string,
    sha: string,
    pollIntervalMs: number,
    deadline: number,
    log: string[]
  ): Promise<CheckRunSummary | null> {
    for (;;) {
      const summary = this._ciStatusRepo.checkRuns(repoPath, sha);
      // `null` means gh/API failure — fail closed immediately.
      if (summary === null) {
        return null;
      }
      // GitHub often reports zero check-runs for several seconds after a
      // push/PR open before Actions registers suites (gh#7401). Keep polling
      // until something appears or the monitor deadline expires — do not
      // treat empty as a terminal "no CI" block on the first sample.
      if (summary.total === 0) {
        if (Date.now() >= deadline) {
          return summary;
        }
        log.push(`waiting for check runs to register for ${sha}`);
        await sleep(pollIntervalMs);
        continue;
      }
      if (summary.pending.length === 0) {
        return summary;
      }
      if (Date.now() >= deadline) {
        return summary;
      }
      log.push(
        `waiting on ${summary.pending.length} pending check(s) for ${sha}`
      );
      await sleep(pollIntervalMs);
    }
  }
}
