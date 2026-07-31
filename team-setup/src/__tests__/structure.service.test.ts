import {
  createDirectories,
  createSymlinks
} from '../services/structure.service';

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  symlinkSync: jest.fn(),
  readlinkSync: jest.fn(),
  existsSync: jest.fn(),
  lstatSync: jest.fn(),
  unlinkSync: jest.fn()
}));

import {
  mkdirSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  lstatSync,
  unlinkSync
} from 'fs';
import path from 'path';

const mockMkdirSync = mkdirSync as jest.Mock;
const mockSymlinkSync = symlinkSync as jest.Mock;
const mockReadlinkSync = readlinkSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockLstatSync = lstatSync as jest.Mock;
const mockUnlinkSync = unlinkSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const project = { id: 'proj', dir: 'proj', repos: [], symlinks: [] };
const projectWithLinks = { ...project, symlinks: ['common'] };

describe('createDirectories', () => {
  it('creates a directory for each project', () => {
    createDirectories('/base', [project]);
    expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/base', 'proj'), {
      recursive: true
    });
  });

  it('handles multiple projects', () => {
    const p2 = { ...project, id: 'p2', dir: 'p2' };
    createDirectories('/base', [project, p2]);
    expect(mockMkdirSync).toHaveBeenCalledTimes(2);
  });
});

describe('createSymlinks', () => {
  it('does nothing when no projects have symlinks', () => {
    createSymlinks('/base', [project]);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('creates symlink when path does not exist', () => {
    mockLstatSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
    createSymlinks('/base', [projectWithLinks]);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      path.join('..', 'shared', 'common'),
      path.join('/base', 'proj', 'common')
    );
  });

  it('skips when symlink already points to correct target', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });
    mockReadlinkSync.mockReturnValue(path.join('..', 'shared', 'common'));
    createSymlinks('/base', [projectWithLinks]);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('replaces stale symlink pointing to wrong target', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });
    mockReadlinkSync.mockReturnValue('../shared/old-target');
    createSymlinks('/base', [projectWithLinks]);
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockSymlinkSync).toHaveBeenCalled();
  });

  it('skips when path exists but is not a symlink', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(true);
    createSymlinks('/base', [projectWithLinks]);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('honors an object symlink entry with a custom target', () => {
    const projectWithObjectLink = {
      ...project,
      symlinks: [
        { name: 'docs', target: '../elsewhere/docs', scope: 'project' as const }
      ]
    };
    mockLstatSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
    createSymlinks('/base', [projectWithObjectLink]);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '../elsewhere/docs',
      path.join('/base', 'proj', 'docs')
    );
  });

  it('creates repo-scoped symlinks inside each existing repo', () => {
    const projectWithRepoLink = {
      ...project,
      repos: [
        { name: 'repo-a', ghRepo: 'repo-a' },
        { name: 'repo-b', ghRepo: 'repo-b' }
      ],
      symlinks: [
        { name: 'assets', target: '../shared/assets', scope: 'repo' as const }
      ]
    };
    // repo-a exists, repo-b does not; link paths do not exist yet.
    mockExistsSync.mockImplementation(
      (p: string) => p.endsWith('repo-a') && !p.endsWith('assets')
    );
    mockLstatSync.mockReturnValue(undefined);
    createSymlinks('/base', [projectWithRepoLink]);
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '../shared/assets',
      path.join('/base', 'proj', 'repo-a', 'assets')
    );
  });
});
