import { Container } from 'inversify';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  DEFAULT_RETRY_ATTEMPT_LIMIT,
  IRetryExecutorService,
  MAX_BACKOFF_MS,
  RetryExecutorService
} from '../services/retry-executor.service';
import type { RecoveryHistory } from '../types';

describe('RetryExecutorService (SPEC-PRD-0021-P1 T-03)', () => {
  let executor: IRetryExecutorService;

  beforeEach(() => {
    const container = new Container();
    container
      .bind<IRetryExecutorService>(WORKFLOW_TOKENS.RetryExecutorService)
      .to(RetryExecutorService);
    executor = container.get<IRetryExecutorService>(
      WORKFLOW_TOKENS.RetryExecutorService
    );
  });

  it('returns the value on the first try without recording a retry', async () => {
    const step = jest.fn().mockResolvedValue('ok');

    const outcome = await executor.run({ path: 'pr:T-01', step });

    expect(outcome.kind).toBe('succeeded');
    expect(step).toHaveBeenCalledTimes(1);
    expect(outcome.history.escalated).toBe(false);
    expect(outcome.history.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        action: 'attempt',
        outcome: 'succeeded'
      })
    ]);
  });

  it('recovers from a transient failure and records both attempts', async () => {
    const step = jest
      .fn()
      .mockRejectedValueOnce(new Error('502 from GitHub'))
      .mockResolvedValue('pr-7');

    const outcome = await executor.run({ path: 'pr:T-01', step, backoffMs: 0 });

    expect(outcome).toMatchObject({ kind: 'succeeded', value: 'pr-7' });
    expect(step).toHaveBeenCalledTimes(2);
    // The history is the evidence a human reads to tell a flaky step from a
    // broken one; a silent recovery would look identical to a clean pass.
    expect(outcome.history.attempts).toEqual([
      expect.objectContaining({ outcome: 'failed', detail: '502 from GitHub' }),
      expect.objectContaining({ attempt: 2, outcome: 'succeeded' })
    ]);
    expect(outcome.history.escalated).toBe(false);
  });

  it('stops at the attempt cap and escalates exactly once', async () => {
    const step = jest.fn().mockRejectedValue(new Error('still broken'));
    const onExhausted = jest.fn();

    const outcome = await executor.run({
      path: 'sandbox:T-02',
      step,
      backoffMs: 0,
      onExhausted
    });

    expect(step).toHaveBeenCalledTimes(DEFAULT_RETRY_ATTEMPT_LIMIT);
    expect(outcome.kind).toBe('exhausted');
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(outcome.history.escalated).toBe(true);
    expect(outcome.history.attempts.at(-1)).toMatchObject({
      action: 'escalate',
      outcome: 'exhausted',
      detail: 'still broken'
    });
  });

  it('honours an explicit attempt limit and never goes below one attempt', async () => {
    const step = jest.fn().mockRejectedValue(new Error('nope'));

    await executor.run({ path: 'p', step, backoffMs: 0, attemptLimit: 1 });
    expect(step).toHaveBeenCalledTimes(1);

    step.mockClear();
    // A zero or negative budget is a caller bug; silently never running the
    // step would report "exhausted" for work that was never attempted.
    await executor.run({ path: 'p', step, backoffMs: 0, attemptLimit: 0 });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('doubles the backoff between attempts and caps it', async () => {
    jest.useFakeTimers();
    try {
      const waits: number[] = [];
      const spy = jest
        .spyOn(global, 'setTimeout')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(((fn: () => void, ms?: number) => {
          waits.push(ms ?? 0);
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout);

      await executor.run({
        path: 'chronicle:T-03',
        step: jest.fn().mockRejectedValue(new Error('x')),
        backoffMs: 20_000,
        attemptLimit: 4
      });

      // 20s, 40s->capped, 80s->capped. An uncapped curve would turn a
      // four-attempt budget into a multi-minute stall.
      expect(waits).toEqual([20_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
      spy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not wait after the final attempt', async () => {
    jest.useFakeTimers();
    try {
      const waits: number[] = [];
      const spy = jest
        .spyOn(global, 'setTimeout')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(((fn: () => void, ms?: number) => {
          waits.push(ms ?? 0);
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout);

      await executor.run({
        path: 'p',
        step: jest.fn().mockRejectedValue(new Error('x')),
        backoffMs: 1_000,
        attemptLimit: 2
      });

      // One gap between two attempts — a trailing sleep is pure dead time
      // before an escalation that is already decided.
      expect(waits).toEqual([1_000]);
      spy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports each failure as it happens, before the backoff', async () => {
    const seen: string[] = [];
    const step = jest.fn().mockImplementation(() => {
      seen.push('attempt');
      return Promise.reject(new Error('boom'));
    });

    await executor.run({
      path: 'p',
      step,
      backoffMs: 0,
      attemptLimit: 2,
      onAttemptFailed: attempt => seen.push(`failed:${attempt.attempt}`)
    });

    expect(seen).toEqual(['attempt', 'failed:1', 'attempt', 'failed:2']);
  });

  it('normalizes a non-Error throw into a readable detail', async () => {
    const outcome = await executor.run({
      path: 'p',
      step: jest.fn().mockRejectedValue('just a string'),
      backoffMs: 0,
      attemptLimit: 1
    });

    expect(outcome.kind).toBe('exhausted');
    if (outcome.kind === 'exhausted') {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error.message).toBe('just a string');
    }
  });

  it('awaits an async onExhausted before returning', async () => {
    const order: string[] = [];

    await executor.run({
      path: 'p',
      step: jest.fn().mockRejectedValue(new Error('x')),
      backoffMs: 0,
      attemptLimit: 1,
      onExhausted: async () => {
        await Promise.resolve();
        order.push('escalated');
      }
    });
    order.push('returned');

    // Returning first would let the caller escalate to a human before the
    // escalation record it points at exists.
    expect(order).toEqual(['escalated', 'returned']);
  });

  it('cannot reach a verdict: the surface exposes no verdict at all', async () => {
    const outcome = await executor.run({
      path: 'p',
      step: jest.fn().mockRejectedValue(new Error('x')),
      backoffMs: 0,
      attemptLimit: 1
    });

    // A retry layer that could soften a gate result would make every gate
    // advisory, so the contract is checked structurally rather than by
    // trusting a comment: nothing verdict-shaped comes back out.
    const keys = Object.keys(outcome).concat(Object.keys(outcome.history));
    expect(keys).not.toContain('verdict');
    expect(keys).not.toContain('outcome');
    expect(JSON.stringify(outcome)).not.toContain('"gate"');
  });

  it('keeps one budget per path label', async () => {
    const first = jest.fn().mockRejectedValue(new Error('a'));
    const second = jest.fn().mockRejectedValue(new Error('b'));

    const a = await executor.run({
      path: 'pr:T-01',
      step: first,
      backoffMs: 0
    });
    const b = await executor.run({
      path: 'pr:T-02',
      step: second,
      backoffMs: 0
    });

    // The executor is stateless across calls: exhausting T-01 must not
    // starve T-02 of its own attempts.
    expect(first).toHaveBeenCalledTimes(DEFAULT_RETRY_ATTEMPT_LIMIT);
    expect(second).toHaveBeenCalledTimes(DEFAULT_RETRY_ATTEMPT_LIMIT);
    expect(historyPath(a.history)).toBe('pr:T-01');
    expect(historyPath(b.history)).toBe('pr:T-02');
  });
});

const historyPath = (history: RecoveryHistory): string => history.path;
