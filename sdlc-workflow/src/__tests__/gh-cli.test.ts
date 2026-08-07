jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('../utils/gh-auth', () => ({
  envForAddiWrite: jest.fn(() => ({ GH_TOKEN: 'addi-token' })),
  resetAddiTokenCache: jest.fn()
}));
jest.mock('../utils/gh-repo', () => ({
  originSlug: jest.fn(() => 'org/repo')
}));

import { execSync } from 'child_process';
import { WorkflowError } from '../types';
import { envForAddiWrite, resetAddiTokenCache } from '../utils/gh-auth';
import { ghEnv, runGh } from '../utils/gh-cli';
import { originSlug } from '../utils/gh-repo';

const execMock = execSync as jest.Mock;
const addiMock = envForAddiWrite as jest.Mock;
const resetMock = resetAddiTokenCache as jest.Mock;
const slugMock = originSlug as jest.Mock;

/** How gh surfaces a dead token: reason on stderr, not in `message`. */
const expiredTokenError = (): Error => {
  const err = new Error('Command failed: gh api repos/org/repo');
  (err as Error & { stderr: string }).stderr = 'gh: Bad credentials (HTTP 401)';
  return err;
};

describe('runGh', () => {
  beforeEach(() => {
    execMock.mockReset();
    resetMock.mockReset();
    slugMock.mockReset().mockReturnValue('org/repo');
    addiMock.mockReset().mockReturnValue({ GH_TOKEN: 'addi-token' });
  });

  it('returns stdout on success', () => {
    execMock.mockReturnValue('output');

    expect(runGh('/repo', 'gh pr view 1')).toBe('output');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  // An installation token lives 60 minutes and a supervised run lives longer,
  // so a call can be issued just as the credential dies. Without the retry
  // the run reads its own expired token as a red gate.
  it('re-mints and retries once when the token has expired', () => {
    execMock
      .mockImplementationOnce(() => {
        throw expiredTokenError();
      })
      .mockReturnValueOnce('recovered');

    expect(runGh('/repo', 'gh api user')).toBe('recovered');
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure that is not an auth failure', () => {
    execMock.mockImplementation(() => {
      throw new Error('HTTP 422: no commit found');
    });

    expect(() => runGh('/repo', 'gh api commits')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
    expect(resetMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry when the fresh token also fails', () => {
    execMock.mockImplementation(() => {
      throw expiredTokenError();
    });

    expect(() => runGh('/repo', 'gh api user')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  // execSync keeps the diagnosis on stderr; reporting `message` alone
  // reduced every failure to "Command failed".
  it('reports stderr in the error details', () => {
    execMock.mockImplementation(() => {
      throw expiredTokenError();
    });

    try {
      runGh('/repo', 'gh api user');
      throw new Error('expected runGh to throw');
    } catch (err) {
      expect((err as WorkflowError).details[0]).toContain('Bad credentials');
    }
  });

  it('reports a non-Error throw as the failure detail', () => {
    execMock.mockImplementation(() => {
      throw 'gh exploded';
    });

    expect(() => runGh('/repo', 'gh api user')).toThrow(
      expect.objectContaining({
        code: 'GH_FAILED',
        details: ['gh exploded']
      })
    );
    expect(resetMock).not.toHaveBeenCalled();
  });

  // Auth selection already failed with a diagnosed WorkflowError; wrapping it
  // in a generic "gh failed" would bury the reason.
  it('propagates a WorkflowError from auth selection without retrying', () => {
    addiMock.mockImplementation(() => {
      throw new WorkflowError('no app', 'GH_NOT_ADDI', []);
    });

    expect(() =>
      runGh('/repo', 'gh issue create', { requireAddi: true })
    ).toThrow(expect.objectContaining({ code: 'GH_NOT_ADDI' }));
    expect(execMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('propagates a WorkflowError raised by the post-re-mint attempt', () => {
    execMock.mockImplementationOnce(() => {
      throw expiredTokenError();
    });
    addiMock
      .mockReturnValueOnce({ GH_TOKEN: 'addi-token' })
      .mockImplementation(() => {
        throw new WorkflowError('no app after re-mint', 'GH_NOT_ADDI', []);
      });

    expect(() => runGh('/repo', 'gh api user', { requireAddi: true })).toThrow(
      expect.objectContaining({ code: 'GH_NOT_ADDI' })
    );
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it('runs the command with the Addi environment', () => {
    execMock.mockReturnValue('');

    runGh('/repo', 'gh issue create', { requireAddi: true });

    expect(execMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        cwd: '/repo',
        env: { GH_TOKEN: 'addi-token' }
      })
    );
  });
});

describe('ghEnv', () => {
  beforeEach(() => {
    slugMock.mockReset().mockReturnValue('org/repo');
    addiMock.mockReset().mockReturnValue({ GH_TOKEN: 'addi-token' });
  });

  it('selects the App for the origin owner', () => {
    ghEnv('/repo');

    expect(addiMock).toHaveBeenCalledWith(
      process.env,
      expect.objectContaining({ owner: 'org', cwd: '/repo' })
    );
  });

  it('prefers an explicit owner override for cross-repo watch polls', () => {
    ghEnv('/workspace', true, {
      owner: 'OtherOrg',
      env: { SDLC_GH_ACTIVATE: '/tmp/activate.sh' }
    });

    expect(addiMock).toHaveBeenCalledWith(
      expect.objectContaining({ SDLC_GH_ACTIVATE: '/tmp/activate.sh' }),
      expect.objectContaining({ owner: 'OtherOrg', cwd: '/workspace' })
    );
  });

  it('falls back to ambient auth for a read when no App resolves', () => {
    addiMock.mockImplementation(() => {
      throw new WorkflowError('no app', 'GH_NOT_ADDI', []);
    });

    expect(ghEnv('/repo').PATH).toBe(process.env.PATH);
  });

  // A write that quietly degrades to ambient auth opens the PR as the human,
  // which is the failure this whole path exists to prevent.
  it('propagates the failure for a write', () => {
    addiMock.mockImplementation(() => {
      throw new WorkflowError('no app', 'GH_NOT_ADDI', []);
    });

    expect(() => ghEnv('/repo', true)).toThrow(
      expect.objectContaining({ code: 'GH_NOT_ADDI' })
    );
  });

  it('skips minting for a read when the checkout has no origin', () => {
    slugMock.mockImplementation(() => {
      throw new WorkflowError('no origin', 'GH_FAILED', []);
    });

    ghEnv('/tmp/scratch');

    expect(addiMock).not.toHaveBeenCalled();
  });
});
