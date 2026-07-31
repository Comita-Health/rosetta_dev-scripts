import { installDeps } from '../services/install.service';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mockExecSync = execSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const project = {
  id: 'proj',
  dir: 'proj',
  repos: [{ name: 'repo-a', ghRepo: 'repo-a' }],
  symlinks: [],
};

describe('installDeps', () => {
  it('skips repos without package.json', () => {
    mockExistsSync.mockReturnValue(false);
    installDeps('/base', [project]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('runs yarn install --frozen-lockfile when package.json exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    installDeps('/base', [project]);
    expect(mockExecSync).toHaveBeenCalledWith(
      'yarn install --frozen-lockfile',
      expect.objectContaining({ cwd: expect.stringContaining('proj/repo-a') })
    );
  });

  it('falls back to yarn install when --frozen-lockfile fails', () => {
    mockExistsSync.mockReturnValue(true);
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('frozen lockfile mismatch');
      return '';
    });
    installDeps('/base', [project]);
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'yarn install', expect.any(Object));
  });

  it('logs warning when both yarn install attempts fail', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => { throw new Error('install failed'); });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    installDeps('/base', [project]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('install failed'));
    consoleSpy.mockRestore();
  });

  it('handles projects with no repos', () => {
    installDeps('/base', [{ ...project, repos: [] }]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
