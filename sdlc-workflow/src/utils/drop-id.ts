import { DropMode, WorkflowError } from '../types';

const DROP_MODES: readonly DropMode[] = [
  'direct',
  'bug-spec',
  'plan-artifact'
];

export const parseDropMode = (raw: string): DropMode => {
  if ((DROP_MODES as readonly string[]).includes(raw)) {
    return raw as DropMode;
  }
  throw new WorkflowError(`invalid drop mode: "${raw}"`, 'DROP_INVALID', [
    'expected direct | bug-spec | plan-artifact'
  ]);
};

const ISSUE_REF = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

export interface ParsedIssueRef {
  owner: string;
  repo: string;
  number: number;
  slug: string;
}

/**
 * Stable directory/branch fragment for a drop id. Rejects empty or
 * path-escaping input so two drops cannot collide on `../`.
 */
export const sanitizeDropId = (dropId: string): string => {
  const trimmed = dropId.trim();
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0 || sanitized.includes('..')) {
    throw new WorkflowError(
      `invalid drop id: "${dropId}"`,
      'DROP_INVALID',
      ['use a non-empty id of letters, digits, dot, underscore, or hyphen']
    );
  }
  return sanitized;
};

export const parseIssueRef = (raw: string): ParsedIssueRef => {
  const match = raw.trim().match(ISSUE_REF);
  if (match === null) {
    throw new WorkflowError(
      `invalid issue ref: "${raw}"`,
      'DROP_INVALID',
      ['expected owner/repo#N']
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    slug: raw.trim()
  };
};

export const dropBranchName = (dropId: string): string =>
  `sdlc/drop/${sanitizeDropId(dropId)}`;
