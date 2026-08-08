import type { RunState } from '../types';
import {
  collectEscalationRefs,
  formatEscalationRefLines,
  humanRequiredCriteria,
  latestTaskVerdict
} from '../utils/escalation-refs';

const baseState = (): RunState =>
  ({
    runId: 'bug-run',
    specId: 'SPEC-BUG-x-P1',
    specPath: '/workspace/specs/BUG-x/phase-1-spec.md',
    baseSha: 'base',
    taskResults: {
      'T-01': {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/bug-run/T-01',
        prUrl: 'https://github.com/org/repo/pull/65',
        recordedAt: 't0'
      }
    },
    verdicts: [
      {
        gate: 'verification',
        taskId: 'T-01',
        outcome: 'human-required',
        wouldEscalate: false,
        reasons: [
          'human required: docs: README states where transcripts live',
          'failed: agent: confinement'
        ],
        evidenceIds: ['T-01-agent-criterion-8'],
        recordedAt: 't1'
      },
      {
        gate: 'sandbox',
        taskId: 'T-01',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: ['deployed and healthy'],
        evidenceIds: ['T-01-sandbox-health'],
        recordedAt: 't2'
      }
    ],
    exceptions: [],
    criterionVerdicts: [],
    steps: {},
    sandbox: {
      sha: 'abc123',
      status: 'healthy',
      contentSha: 'tree',
      recordedAt: 't2'
    },
    tokenSpendK: 0,
    ciFixAttempts: {},
    gateFixAttempts: {},
    remediations: {},
    mergeBlockedRetries: 0,
    updatedAt: 't2'
  }) as RunState;

describe('escalation-refs', () => {
  it('collects PR, branch, head, spec, human-required, CI, and sandbox refs', () => {
    const refs = collectEscalationRefs({
      state: baseState(),
      taskId: 'T-01',
      headSha: 'abc123',
      ciCheckUrls: [
        { name: 'test', url: 'https://github.com/org/repo/actions/runs/1' }
      ]
    });

    expect(refs).toEqual({
      prUrl: 'https://github.com/org/repo/pull/65',
      headSha: 'abc123',
      branch: 'sdlc/bug-run/T-01',
      specPath: '/workspace/specs/BUG-x/phase-1-spec.md',
      humanRequired: ['docs: README states where transcripts live'],
      ciCheckUrls: [
        { name: 'test', url: 'https://github.com/org/repo/actions/runs/1' }
      ],
      sandbox: {
        sha: 'abc123',
        status: 'healthy',
        evidenceId: 'T-01-sandbox-health'
      }
    });
  });

  it('formats markdown lines for the issue body', () => {
    const lines = formatEscalationRefLines('bug-run', {
      prUrl: 'https://github.com/org/repo/pull/65',
      branch: 'sdlc/bug-run/T-01',
      headSha: 'abc123',
      specPath: '/specs/x.md',
      humanRequired: ['criterion A'],
      ciCheckUrls: [
        { name: 'test', url: 'https://github.com/org/repo/actions/runs/1' }
      ],
      sandbox: {
        sha: 'abc123',
        status: 'failed',
        evidenceId: 'T-01-sandbox-health'
      }
    });

    expect(lines.join('\n')).toContain('**Blocker PR:**');
    expect(lines.join('\n')).toContain('### Human-required criteria');
    expect(lines.join('\n')).toContain(
      '[test](https://github.com/org/repo/actions/runs/1)'
    );
    expect(lines.join('\n')).toContain(
      'runs://bug-run/evidence/T-01-sandbox-health'
    );
  });

  it('latestTaskVerdict prefers the newest recordedAt', () => {
    const state = baseState();
    state.verdicts.push({
      gate: 'verification',
      taskId: 'T-01',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: [],
      recordedAt: 't9'
    });
    expect(latestTaskVerdict(state, 'T-01', 'verification')?.outcome).toBe(
      'pass'
    );
    expect(
      humanRequiredCriteria(latestTaskVerdict(state, 'T-01', 'verification'))
    ).toEqual([]);
  });

  it('omits empty optional fields and returns no refs for an unknown task', () => {
    const state = baseState();
    state.taskResults = {};
    state.verdicts = [];
    state.sandbox = undefined;
    state.specPath = '';

    expect(
      collectEscalationRefs({
        state,
        taskId: 'T-99',
        headSha: '',
        ciCheckUrls: []
      })
    ).toEqual({});
    expect(latestTaskVerdict(state, 'T-99', 'verification')).toBeUndefined();
    expect(humanRequiredCriteria(undefined)).toEqual([]);
  });

  it('collects sandbox evidence without a sandbox record, and record without evidence', () => {
    const withEvidenceOnly = baseState();
    withEvidenceOnly.sandbox = undefined;
    expect(
      collectEscalationRefs({ state: withEvidenceOnly, taskId: 'T-01' }).sandbox
    ).toEqual({ evidenceId: 'T-01-sandbox-health' });

    const withRecordOnly = baseState();
    withRecordOnly.verdicts = withRecordOnly.verdicts.filter(
      verdict => verdict.gate !== 'sandbox'
    );
    expect(
      collectEscalationRefs({ state: withRecordOnly, taskId: 'T-01' }).sandbox
    ).toEqual({ sha: 'abc123', status: 'healthy' });
  });

  it('formats sparse sandbox and skips empty human-required / CI sections', () => {
    const sparse = formatEscalationRefLines('bug-run', {
      sandbox: { evidenceId: 'T-01-sandbox-health' }
    }).join('\n');
    expect(sparse).toContain('### Sandbox');
    expect(sparse).toContain('runs://bug-run/evidence/T-01-sandbox-health');
    expect(sparse).not.toContain('### Human-required');
    expect(sparse).not.toContain('### CI');

    const statusOnly = formatEscalationRefLines('bug-run', {
      sandbox: { status: 'failed' }
    }).join('\n');
    expect(statusOnly).toContain('status=`failed`');
  });
});
