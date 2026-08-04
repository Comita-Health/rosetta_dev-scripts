import { runExitCode } from '../utils/run-exit';
import type { SuperviseResult } from '../services/supervise.service';

const result = (over: Partial<SuperviseResult>): SuperviseResult => ({
  kind: 'completed',
  waves: 1,
  ...over
});

describe('runExitCode', () => {
  it('exits non-zero for a refused intake (blocked wave -> failed run) (#37)', () => {
    // Shape produced by ExecutorService.loadSpecForRun on an unapproved spec:
    // the wave reports 'blocked', which the supervise loop maps to 'failed'.
    const refused = result({
      kind: 'failed',
      detail: 'blocked',
      lastWave: { outcome: 'blocked', tasks: [] }
    });
    expect(runExitCode(refused)).toBe(1);
  });

  it('exits non-zero when the single-wave outcome is blocked', () => {
    const blocked = result({
      kind: 'stopped',
      lastWave: { outcome: 'blocked', tasks: [] }
    });
    expect(runExitCode(blocked)).toBe(1);
  });

  it('exits non-zero when any task failed', () => {
    const failedTask = result({
      kind: 'stopped',
      lastWave: {
        outcome: 'executed',
        tasks: [{ taskId: 'T-01', kind: 'failed', branch: 'b' }]
      }
    });
    expect(runExitCode(failedTask)).toBe(1);
  });

  it('exits zero for a completed run', () => {
    const completed = result({
      kind: 'completed',
      lastWave: {
        outcome: 'executed',
        tasks: [{ taskId: 'T-01', kind: 'completed', branch: 'b' }]
      }
    });
    expect(runExitCode(completed)).toBe(0);
  });

  it('exits zero for a stopped run with no wave (nothing to react to)', () => {
    expect(runExitCode(result({ kind: 'stopped' }))).toBe(0);
  });

  it('exits non-zero when detach parent reports a startup-dead child (#38)', () => {
    // Parent maps a child that died during the startup grace (missing spec,
    // refused intake, unparseable) to kind: 'failed' — never exit 0.
    expect(
      runExitCode(
        result({
          kind: 'failed',
          waves: 0,
          detail: 'SPEC_MALFORMED: Spec file not found'
        })
      )
    ).toBe(1);
  });
});
