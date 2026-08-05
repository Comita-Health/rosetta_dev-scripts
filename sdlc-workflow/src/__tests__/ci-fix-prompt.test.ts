import { buildCiFixPrompt } from '../utils/ci-fix-prompt';
import { makeTask } from './fixtures';

describe('buildCiFixPrompt (P3 T-03)', () => {
  const task = makeTask();

  it('names the failing checks, the attempt number, and the commit contract', () => {
    const prompt = buildCiFixPrompt(
      task,
      ['Typecheck', 'Unit tests'],
      'error TS2345: bad argument',
      2,
      3
    );

    expect(prompt).toContain(`task ${task.id}`);
    expect(prompt).toContain('fix attempt 2 of 3');
    expect(prompt).toContain('- Typecheck');
    expect(prompt).toContain('- Unit tests');
    expect(prompt).toContain('error TS2345: bad argument');
    // The agent's work only counts if it commits: an uncommitted worktree is
    // recorded as a failed attempt, so the instruction has to be explicit.
    expect(prompt).toContain('git commit --no-verify -s');
    expect(prompt).toContain(`fix(${task.id})`);
  });

  it('says the logs are unavailable rather than leaving a blank section', () => {
    // A silent gap reads as "CI failed for no reason" and the agent invents a
    // cause; naming the gap tells it to reproduce locally instead.
    const prompt = buildCiFixPrompt(task, ['Typecheck'], '', 1, 3);

    expect(prompt).toContain('(logs unavailable — rerun locally)');
  });
});
