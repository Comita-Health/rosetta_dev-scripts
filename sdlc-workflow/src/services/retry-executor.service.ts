import { injectable } from 'inversify';
import { RecoveryAttempt, RecoveryHistory } from '../types';

/** Default terminal cap per recovery path. */
export const DEFAULT_RETRY_ATTEMPT_LIMIT = 3;
/** Default first backoff; doubles per attempt up to {@link MAX_BACKOFF_MS}. */
export const DEFAULT_RETRY_BACKOFF_MS = 2_000;
/**
 * Backoff ceiling. Unbounded doubling turns a five-attempt budget into a
 * multi-hour stall, which is the failure mode this whole phase exists to
 * remove — a slow retry is still dead time.
 */
export const MAX_BACKOFF_MS = 30_000;

export interface RetryInput<T> {
  /**
   * Recovery path label, e.g. `pr:T-01`. One attempt budget per label; use a
   * label that includes the task so two tasks do not share one budget.
   */
  path: string;
  /**
   * The work to retry. Throwing means "failed, try again"; returning means
   * success. It is the *only* thing re-invoked — see the class remarks.
   */
  step: () => Promise<T>;
  /** Terminal cap. Defaults to {@link DEFAULT_RETRY_ATTEMPT_LIMIT}. */
  attemptLimit?: number;
  /** First backoff in ms; doubles per attempt. Pass `0` to disable waiting. */
  backoffMs?: number;
  /** Called at most once, only when the cap is exhausted. */
  onExhausted?: (history: RecoveryHistory) => void | Promise<void>;
  /** Called after each failed attempt, before the backoff. */
  onAttemptFailed?: (attempt: RecoveryAttempt) => void;
}

export type RetryOutcome<T> =
  | { kind: 'succeeded'; value: T; history: RecoveryHistory }
  | { kind: 'exhausted'; error: Error; history: RecoveryHistory };

/**
 * The engine's single retry-policy surface (SPEC-PRD-0021-P1 T-03): the
 * attempt cap, the backoff curve, and the {@link RecoveryHistory} schema are
 * defined here exactly once so later consumers cannot each invent their own.
 *
 * @remarks
 * **This executor cannot influence a verdict.** It re-invokes the supplied
 * callback and records what happened; it has no reference to a verdict type,
 * no gate knowledge, and no branch that constructs or edits one. That is a
 * deliberate structural property, not a convention: a retry layer able to
 * soften a gate result would make every gate advisory, and the failure would
 * look like a passing run rather than a bug.
 *
 * Exhaustion is terminal and loud. `onExhausted` fires exactly once, then the
 * executor returns — it never loops past the cap, so a permanently failing
 * step costs a bounded amount of time instead of spinning until a human
 * notices.
 */
export interface IRetryExecutorService {
  run<T>(input: RetryInput<T>): Promise<RetryOutcome<T>>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

@injectable()
export class RetryExecutorService implements IRetryExecutorService {
  async run<T>(input: RetryInput<T>): Promise<RetryOutcome<T>> {
    const limit = Math.max(
      1,
      input.attemptLimit ?? DEFAULT_RETRY_ATTEMPT_LIMIT
    );
    const baseBackoff = input.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const history: RecoveryHistory = {
      path: input.path,
      attempts: [],
      escalated: false
    };
    let lastError = new Error(`no attempt was made for ${input.path}`);

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      try {
        const value = await input.step();
        history.attempts.push(
          record(attempt, 'attempt', 'succeeded', undefined)
        );
        return { kind: 'succeeded', value, history };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failure = record(attempt, 'attempt', 'failed', lastError.message);
        history.attempts.push(failure);
        input.onAttemptFailed?.(failure);
      }

      if (attempt < limit && baseBackoff > 0) {
        const waitMs = Math.min(
          baseBackoff * 2 ** (attempt - 1),
          MAX_BACKOFF_MS
        );
        history.attempts.push(
          record(attempt, 'backoff', 'waited', `${waitMs}ms`)
        );
        await sleep(waitMs);
      }
    }

    history.escalated = true;
    history.attempts.push(
      record(limit, 'escalate', 'exhausted', lastError.message)
    );
    await input.onExhausted?.(history);
    return { kind: 'exhausted', error: lastError, history };
  }
}

const record = (
  attempt: number,
  action: RecoveryAttempt['action'],
  outcome: RecoveryAttempt['outcome'],
  detail: string | undefined
): RecoveryAttempt => ({
  attempt,
  action,
  outcome,
  detail,
  at: new Date().toISOString()
});
