import { verifySetup } from '../services/verify.service';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  lstatSync: jest.fn(),
  readlinkSync: jest.fn(),
}));

import { execSync } from 'child_process';
import { existsSync, lstatSync, readlinkSync } from 'fs';
import path from 'path';

const mockExecSync = execSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockLstatSync = lstatSync as jest.Mock;
const mockReadlinkSync = readlinkSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const shared = {
  org: 'MyOrg',
  baseDir: '/base',
  sharedRepos: [{ name: 'common', ghRepo: 'common' }],
  flatRepos: [],
};

const project = {
  id: 'proj',
  dir: 'proj',
  repos: [{ name: 'repo-a', ghRepo: 'repo-a' }],
  symlinks: [],
};

const projectWithLink = { ...project, symlinks: ['common'] };

describe('verifySetup', () => {
  it('reports all checks passed when workspace is healthy', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('https://github.com/org/repo');
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [project], shared);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All checks passed'));
    consoleSpy.mockRestore();
  });

  it('counts missing shared repo as an issue', () => {
    mockExistsSync.mockImplementation((p: string) => !p.includes('shared/common'));
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [], shared);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts missing project repo as an issue', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.git'));
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [project], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts repo with no remote as an issue', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('remote get-url')) throw new Error('no remote');
      return '';
    });
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [project], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts valid symlink as passing', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });
    mockReadlinkSync.mockReturnValue(path.join('..', 'shared', 'common'));
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [projectWithLink], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All checks passed'));
    consoleSpy.mockRestore();
  });

  it('counts broken symlink as an issue', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('CLAUDE.md')) return true;
      if (p.endsWith('settings.json')) return true;
      return false;
    });
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });
    mockReadlinkSync.mockReturnValue(path.join('..', 'shared', 'common'));
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [projectWithLink], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts missing symlink as an issue', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [projectWithLink], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts missing flat repo as an issue', () => {
    mockExistsSync.mockImplementation((p: string) => !p.includes('flat-repo'));
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [], { ...shared, sharedRepos: [], flatRepos: [{ name: 'flat-repo', ghRepo: 'flat-repo' }] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });

  it('counts missing CLAUDE.md as an issue', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('CLAUDE.md'));
    mockExecSync.mockReturnValue('');
    mockLstatSync.mockReturnValue(undefined);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    verifySetup('/base', [project], { ...shared, sharedRepos: [] });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('issue(s) found'));
    consoleSpy.mockRestore();
  });
});
