import { prBody, prTitle } from '../utils/pr-content';
import { GateVerdict, SpecDocument, SpecTask } from '../types';

const task: SpecTask = {
  id: 'T-01',
  storyId: 'S-01',
  phase: 3,
  title: 'do the thing',
  engineeringNotes: '',
  complexity: 'S',
  dependsOn: ['T-00'],
  acceptanceCriteria: ['test: works']
};

const spec: SpecDocument = {
  id: 'SPEC-X',
  prdId: 'PRD-X',
  phase: 3,
  status: 'Approved',
  envelope: {
    allowedPaths: ['**'],
    forbiddenSurfaces: [],
    maxDiffLines: 100,
    budgetK: 50
  },
  tasks: [task]
};

describe('pr-content (P3 T-02)', () => {
  it('builds a deterministic title', () => {
    expect(prTitle('run-1', task)).toBe('sdlc(run-1): T-01 do the thing');
  });

  it('includes dependsOn, acceptance criteria, and gate verdicts in the body', () => {
    const verdicts: GateVerdict[] = [
      {
        gate: 'envelope',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: ['clean'],
        recordedAt: 'x'
      }
    ];
    const body = prBody(spec, task, 'run-1', 'sdlc/run-1/T-01', verdicts);
    expect(body).toContain('T-01');
    expect(body).toContain('Depends on: T-00');
    expect(body).toContain('test: works');
    expect(body).toContain('envelope: **pass** — clean');
  });

  it('notes when gate verdicts have not been recorded yet', () => {
    const body = prBody(spec, { ...task, dependsOn: [] }, 'run-1', 'b', []);
    expect(body).toContain('_Recorded after the machine gates run');
    expect(body).not.toContain('Depends on:');
  });
});
