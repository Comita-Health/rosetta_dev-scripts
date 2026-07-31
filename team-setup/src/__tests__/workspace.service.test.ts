import { generateWorkspaceFile } from '../services/workspace.service';
import { LocalFolderEntry } from '../types';

jest.mock('fs', () => ({ writeFileSync: jest.fn() }));

import { writeFileSync } from 'fs';
import path from 'path';

const mockWriteFileSync = writeFileSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const baseShared = { org: 'MyOrg', baseDir: '~/projects/rosetta', sharedRepos: [], flatRepos: [] };
const project = {
  id: 'my-proj',
  dir: 'my-proj',
  repos: [{ name: 'repo-a', ghRepo: 'repo-a' }],
  symlinks: [],
};

describe('generateWorkspaceFile', () => {
  it('does not include root folder', () => {
    generateWorkspaceFile('/base', [], baseShared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders.find((f: { path: string }) => f.path === '.')).toBeUndefined();
  });

  it('writes to all.code-workspace in baseDir', () => {
    generateWorkspaceFile('/base', [], baseShared);
    expect(mockWriteFileSync.mock.calls[0][0]).toBe(path.join('/base', 'all.code-workspace'));
  });

  it('includes shared repos under shared/', () => {
    const shared = { ...baseShared, sharedRepos: [{ name: 'common', ghRepo: 'common' }] };
    generateWorkspaceFile('/base', [], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: path.join('shared', 'common') });
  });

  it('includes project repos under project dir', () => {
    generateWorkspaceFile('/base', [project], baseShared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: path.join('my-proj', 'repo-a') });
  });

  it('includes flat repos at root level', () => {
    const shared = { ...baseShared, flatRepos: [{ name: 'flat-repo', ghRepo: 'flat-repo' }] };
    generateWorkspaceFile('/base', [], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: 'flat-repo' });
  });

  it('produces valid JSON with trailing newline', () => {
    generateWorkspaceFile('/base', [project], baseShared);
    const raw: string = mockWriteFileSync.mock.calls[0][1];
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('uses label as folder name for shared repos when provided', () => {
    const shared = { ...baseShared, sharedRepos: [{ name: 'common', ghRepo: 'common', label: 'Shared Common' }] };
    generateWorkspaceFile('/base', [], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: path.join('shared', 'common'), name: 'Shared Common' });
  });

  it('uses label as folder name for project repos when provided', () => {
    const labeledProject = { ...project, repos: [{ name: 'repo-a', ghRepo: 'repo-a', label: 'Repo A' }] };
    generateWorkspaceFile('/base', [labeledProject], baseShared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: path.join('my-proj', 'repo-a'), name: 'Repo A' });
  });

  it('uses label as folder name for flat repos when provided', () => {
    const shared = { ...baseShared, flatRepos: [{ name: 'flat-repo', ghRepo: 'flat-repo', label: 'Flat Repo' }] };
    generateWorkspaceFile('/base', [], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: 'flat-repo', name: 'Flat Repo' });
  });

  it('includes personal chronicle repo when resolvedPersonalChronicleRepo is set', () => {
    const shared = {
      ...baseShared,
      personalChronicle: {
        namePrefix: 'rosetta_chronicle',
        visibility: 'private' as const,
        label: 'Chronicle — Personal Memory',
        description: 'desc',
        defaultBranch: 'main',
      },
      resolvedPersonalChronicleRepo: 'rosetta_chronicle_alice',
    };
    generateWorkspaceFile('/base', [], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({
      path: 'rosetta_chronicle_alice',
      name: 'Chronicle — Personal Memory',
    });
  });

  it('omits personal chronicle when resolvedPersonalChronicleRepo is not set', () => {
    generateWorkspaceFile('/base', [], baseShared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders.some((f: { path: string }) => f.path.startsWith('rosetta_chronicle_'))).toBe(false);
  });

  it('orders folders: shared, projects, flat', () => {
    const shared = {
      ...baseShared,
      sharedRepos: [{ name: 'shared-lib', ghRepo: 'shared-lib' }],
      flatRepos: [{ name: 'flat', ghRepo: 'flat' }],
    };
    generateWorkspaceFile('/base', [project], shared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    const paths = written.folders.map((f: { path: string }) => f.path);
    expect(paths[0]).toBe(path.join('shared', 'shared-lib'));
    expect(paths[1]).toBe(path.join('my-proj', 'repo-a'));
    expect(paths[2]).toBe('flat');
  });

  // ─── Local folders (PRD-0008) ──────────────────────────────────────────────

  it('includes local folders when provided', () => {
    const localFolders: LocalFolderEntry[] = [
      { path: '../my-personal-repo', name: 'Personal Repo' },
    ];
    generateWorkspaceFile('/base', [], baseShared, localFolders);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: '../my-personal-repo', name: 'Personal Repo' });
  });

  it('includes local folders without name when name is omitted', () => {
    const localFolders: LocalFolderEntry[] = [{ path: '/absolute/scratch' }];
    generateWorkspaceFile('/base', [], baseShared, localFolders);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toContainEqual({ path: '/absolute/scratch' });
  });

  it('places local folders after flat repos but before personal chronicle', () => {
    const shared = {
      ...baseShared,
      flatRepos: [{ name: 'flat-repo', ghRepo: 'flat-repo' }],
      personalChronicle: {
        namePrefix: 'rosetta_chronicle',
        visibility: 'private' as const,
        label: 'Chronicle — Personal Memory',
        description: 'desc',
        defaultBranch: 'main',
      },
      resolvedPersonalChronicleRepo: 'rosetta_chronicle_alice',
    };
    const localFolders: LocalFolderEntry[] = [{ path: '../local-dir', name: 'Local' }];
    generateWorkspaceFile('/base', [], shared, localFolders);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    const paths = written.folders.map((f: { path: string }) => f.path);
    expect(paths.indexOf('../local-dir')).toBeGreaterThan(paths.indexOf('flat-repo'));
    expect(paths.indexOf('../local-dir')).toBeLessThan(paths.indexOf('rosetta_chronicle_alice'));
  });

  it('works with empty localFolders array (no change to output)', () => {
    generateWorkspaceFile('/base', [], baseShared, []);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toEqual([]);
  });

  it('defaults localFolders to empty when not provided', () => {
    generateWorkspaceFile('/base', [], baseShared);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.folders).toEqual([]);
  });
});
