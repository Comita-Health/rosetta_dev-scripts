import { buildRetroPrompt } from '../utils/retro-prompt';
import { ExceptionEntry, GateVerdict } from '../types';

const verdict = (overrides: Partial<GateVerdict> = {}): GateVerdict => ({
  gate: 'envelope',
  outcome: 'breach',
  wouldEscalate: true,
  reasons: [],
  recordedAt: 'x',
  ...overrides
});

const exception = (overrides: Partial<ExceptionEntry> = {}): ExceptionEntry => ({
  trigger: 'envelope-breach',
  context: [],
  recordedAt: 'x',
  ...overrides
});

describe('buildRetroPrompt (SPEC-BUG-retro-and-queued-plans-P1 T-01)', () => {
  it('falls back to placeholder prose when context, verdicts, and exceptions are all empty', () => {
    const prompt = buildRetroPrompt('SPEC-BUG-empty-P1', '', [], []);

    expect(prompt).toContain('_(no Context section recorded)_');
    expect(prompt).toContain('_(no verdicts recorded)_');
    expect(prompt).toContain('_(no exceptions recorded)_');
  });

  it('renders non-empty context verbatim', () => {
    const prompt = buildRetroPrompt(
      'SPEC-BUG-x-P1',
      'Symptom: it broke.',
      [],
      []
    );

    expect(prompt).toContain('Symptom: it broke.');
    expect(prompt).not.toContain('_(no Context section recorded)_');
  });

  it('renders a run-level verdict (no taskId) without a reasons suffix', () => {
    const prompt = buildRetroPrompt(
      'SPEC-BUG-x-P1',
      'ctx',
      [verdict({ taskId: undefined, reasons: [] })],
      []
    );

    expect(prompt).toContain('- [run] envelope: breach');
    expect(prompt).not.toContain('_(no verdicts recorded)_');
  });

  it('renders a task-scoped verdict with a joined reasons suffix', () => {
    const prompt = buildRetroPrompt(
      'SPEC-BUG-x-P1',
      'ctx',
      [verdict({ taskId: 'T-02', reasons: ['reason one', 'reason two'] })],
      []
    );

    expect(prompt).toContain(
      '- [T-02] envelope: breach — reason one; reason two'
    );
  });

  it('renders a run-level exception (no taskId)', () => {
    const prompt = buildRetroPrompt(
      'SPEC-BUG-x-P1',
      'ctx',
      [],
      [exception({ taskId: undefined, context: ['a', 'b'] })]
    );

    expect(prompt).toContain('- [run] envelope-breach: a; b');
    expect(prompt).not.toContain('_(no exceptions recorded)_');
  });

  it('renders a task-scoped exception', () => {
    const prompt = buildRetroPrompt(
      'SPEC-BUG-x-P1',
      'ctx',
      [],
      [exception({ taskId: 'T-03', context: ['outside allowedPaths'] })]
    );

    expect(prompt).toContain('- [T-03] envelope-breach: outside allowedPaths');
  });

  it('includes the spec id in the Context heading', () => {
    const prompt = buildRetroPrompt('SPEC-BUG-redirect-uri-P1', 'ctx', [], []);

    expect(prompt).toContain('## Spec SPEC-BUG-redirect-uri-P1 — Context');
  });
});
