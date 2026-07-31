import {
  cloneRepo,
  cloneRepos,
  cloneSharedRepos,
  cloneFlatRepos
} from '../services/clone.service';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mockExecSync = execSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;

const repo = { name: 'my-repo', ghRepo: 'my-repo' };

beforeEach(() => jest.clearAllMocks());

describe('cloneRepo', () => {
  it('skips when .git already exists', () => {
    mockExistsSync.mockReturnValue(true);
    const result = cloneRepo(repo, '/base/my-repo', 'MyOrg');
    expect(result).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('clones when .git does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');
    const result = cloneRepo(repo, '/base/my-repo', 'MyOrg');
    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'gh repo clone MyOrg/my-repo "/base/my-repo"',
      expect.any(Object)
    );
  });

  it('returns false and logs error when clone fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error('auth failure');
    });
    const result = cloneRepo(repo, '/base/my-repo', 'MyOrg');
    expect(result).toBe(false);
  });

  it('returns false when a non-Error is thrown', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw 'string error';
    });
    const result = cloneRepo(repo, '/base/my-repo', 'MyOrg');
    expect(result).toBe(false);
  });
});

describe('cloneRepos', () => {
  it('clones each repo into baseDir/subDir/name', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');
    cloneRepos([repo], '/base', 'myproject', 'MyOrg');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('/base/myproject/my-repo'),
      expect.any(Object)
    );
  });
});

describe('cloneSharedRepos', () => {
  it('does nothing when repos list is empty', () => {
    cloneSharedRepos([], '/base', 'MyOrg');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('clones into shared/ subdirectory', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');
    cloneSharedRepos([repo], '/base', 'MyOrg');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('/base/shared/my-repo'),
      expect.any(Object)
    );
  });
});

describe('cloneFlatRepos', () => {
  it('does nothing when repos list is empty', () => {
    cloneFlatRepos([], '/base', 'MyOrg');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('clones directly into baseDir', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');
    cloneFlatRepos([repo], '/base', 'MyOrg');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('/base/my-repo'),
      expect.any(Object)
    );
  });
});
