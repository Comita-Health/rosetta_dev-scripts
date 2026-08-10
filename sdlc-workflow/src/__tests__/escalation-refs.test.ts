import type { RunState } from '../types';
import {
  collectEscalationRefs,
  formatEscalationRefLines,
  githubBlobUrl,
  githubCommitUrl,
  githubTreeUrl,
  humanRequiredCriteria,
  latestTaskVerdict,
  linkifyRepoPathsInText,
  repoRelativePath
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
          'human required: docs: sdlc-workflow/README.md states where transcripts live',
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
    operatorUnstickAttempts: {},
    operatorUnstickOutcomes: {},
    escalateTiers: {},
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
      repoSlug: 'org/repo',
      repoPath: '/workspace',
      ciCheckUrls: [
        { name: 'test', url: 'https://github.com/org/repo/actions/runs/1' }
      ]
    });

    expect(refs).toEqual({
      repoSlug: 'org/repo',
      repoPath: '/workspace',
      prUrl: 'https://github.com/org/repo/pull/65',
      headSha: 'abc123',
      branch: 'sdlc/bug-run/T-01',
      specPath: '/workspace/specs/BUG-x/phase-1-spec.md',
      humanRequired: [
        'docs: sdlc-workflow/README.md states where transcripts live'
      ],
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

  it('formats markdown lines with GitHub deep links when repoSlug is set', () => {
    const lines = formatEscalationRefLines('bug-run', {
      repoSlug: 'org/repo',
      repoPath: '/workspace',
      prUrl: 'https://github.com/org/repo/pull/65',
      branch: 'sdlc/bug-run/T-01',
      headSha: 'abc123',
      specPath: '/workspace/specs/x.md',
      humanRequired: [
        'docs: sdlc-workflow/README.md states where transcripts live'
      ],
      ciCheckUrls: [
        { name: 'test', url: 'https://github.com/org/repo/actions/runs/1' }
      ],
      sandbox: {
        sha: 'abc123',
        status: 'failed',
        evidenceId: 'T-01-sandbox-health'
      }
    }).join('\n');

    expect(lines).toContain('**Blocker PR:**');
    expect(lines).toContain(
      '[`sdlc/bug-run/T-01`](https://github.com/org/repo/tree/sdlc/bug-run/T-01)'
    );
    expect(lines).toContain(
      '[`abc123`](https://github.com/org/repo/commit/abc123)'
    );
    expect(lines).toContain(
      '[`specs/x.md`](https://github.com/org/repo/blob/abc123/specs/x.md)'
    );
    expect(lines).toContain(
      '[`sdlc-workflow/README.md`](https://github.com/org/repo/blob/abc123/sdlc-workflow/README.md)'
    );
    expect(lines).toContain(
      '[test](https://github.com/org/repo/actions/runs/1)'
    );
    expect(lines).toContain('runs://bug-run/evidence/T-01-sandbox-health');
    expect(lines).toContain('local run evidence');
  });

  it('falls back to monospace when repoSlug is absent', () => {
    const lines = formatEscalationRefLines('bug-run', {
      branch: 'sdlc/bug-run/T-01',
      headSha: 'abc123',
      specPath: 'specs/x.md'
    }).join('\n');
    expect(lines).toContain('**Branch:** `sdlc/bug-run/T-01`');
    expect(lines).not.toContain('https://github.com/');
  });

  it('repoRelativePath and GitHub URL helpers', () => {
    expect(repoRelativePath('/workspace/specs/a.md', '/workspace')).toBe(
      'specs/a.md'
    );
    expect(repoRelativePath('specs/a.md')).toBe('specs/a.md');
    expect(repoRelativePath('/elsewhere/file.md', '/workspace')).toBe(
      undefined
    );
    expect(repoRelativePath('/tmp/sdlc-workflow/README.md')).toBe(
      'sdlc-workflow/README.md'
    );
    expect(githubTreeUrl('org/repo', 'sdlc/x/T-01')).toBe(
      'https://github.com/org/repo/tree/sdlc/x/T-01'
    );
    expect(githubCommitUrl('org/repo', 'deadbeef')).toBe(
      'https://github.com/org/repo/commit/deadbeef'
    );
    expect(githubBlobUrl('org/repo', 'main', 'docs/a.md')).toBe(
      'https://github.com/org/repo/blob/main/docs/a.md'
    );
    expect(
      linkifyRepoPathsInText(
        'see sdlc-workflow/README.md please',
        'org/repo',
        'abc'
      )
    ).toContain('blob/abc/sdlc-workflow/README.md');
    expect(
      linkifyRepoPathsInText(
        'see sdlc-workflow/README.md please',
        undefined,
        'abc'
      )
    ).toBe('see sdlc-workflow/README.md please');
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
