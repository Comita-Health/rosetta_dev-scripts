import { WorkflowError } from '../types';
import {
  dropBranchName,
  parseDropMode,
  parseIssueRef,
  sanitizeDropId
} from '../utils/drop-id';

describe('drop-id', () => {
  it('sanitizes a drop id and rejects empty or escaping input', () => {
    expect(sanitizeDropId('acme-app#504')).toBe('acme-app-504');
    expect(dropBranchName('2026-08-15')).toBe('sdlc/drop/2026-08-15');
    expect(() => sanitizeDropId('   ')).toThrow(WorkflowError);
    expect(() => sanitizeDropId('..')).toThrow(WorkflowError);
  });

  it('parses owner/repo#N and rejects other shapes', () => {
    expect(parseIssueRef('Rosetta-Foundation/rosetta_docs#57')).toEqual({
      owner: 'Rosetta-Foundation',
      repo: 'rosetta_docs',
      number: 57,
      slug: 'Rosetta-Foundation/rosetta_docs#57'
    });
    expect(parseDropMode('direct')).toBe('direct');
    expect(() => parseDropMode('shadow')).toThrow(WorkflowError);
    expect(() => parseIssueRef('not-an-issue')).toThrow(WorkflowError);
    try {
      parseIssueRef('not-an-issue');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).details.join(' ')).toContain(
        'owner/repo#N'
      );
    }
  });
});
