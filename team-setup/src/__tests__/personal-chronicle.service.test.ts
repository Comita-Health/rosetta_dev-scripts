import {
  resolveGitHubUser,
  derivePersonalRepoName,
  installChronicleHook,
  installCursorChronicleHooks,
  buildChronicleEngine,
  seedPersonalRepoFiles,
  provisionPersonalChronicle
} from '../services/personal-chronicle.service';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}));

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const mockExecSync = execSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockReadFileSync = readFileSync as jest.Mock;
const mockWriteFileSync = writeFileSync as jest.Mock;
const mockMkdirSync = mkdirSync as jest.Mock;

const config = {
  namePrefix: 'rosetta_chronicle',
  visibility: 'private' as const,
  label: 'Chronicle — Personal Memory',
  description: 'Personal engineering Chronicle.',
  defaultBranch: 'main'
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // Default: settings file does not exist, writes succeed.
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  mockWriteFileSync.mockImplementation(() => {});
});

afterEach(() => (console.log as jest.Mock).mockRestore());

describe('derivePersonalRepoName', () => {
  it('lowercases the login and appends it to the prefix', () => {
    expect(derivePersonalRepoName('rosetta_chronicle', 'Example-User')).toBe(
      'rosetta_chronicle_example-user'
    );
  });

  it('collapses slashes in the login to underscores', () => {
    expect(derivePersonalRepoName('rosetta_chronicle', 'org/user')).toBe(
      'rosetta_chronicle_org_user'
    );
  });
});

describe('resolveGitHubUser', () => {
  it('returns the trimmed login on success', () => {
    mockExecSync.mockReturnValue('example-user\n');
    expect(resolveGitHubUser()).toBe('example-user');
  });

  it('returns null when gh throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not authenticated');
    });
    expect(resolveGitHubUser()).toBeNull();
  });

  it('returns null when gh returns an empty login', () => {
    mockExecSync.mockReturnValue('\n');
    expect(resolveGitHubUser()).toBeNull();
  });
});

describe('installChronicleHook', () => {
  const REPO = '/base/rosetta_chronicle_example-user';
  const HOOK = '/base/rosetta_chronicle/hooks/stop-append.sh';
  const PROJECTS = '/base';

  const writtenJsonFor = (suffix: string): Record<string, unknown> => {
    const call = mockWriteFileSync.mock.calls.find((c: string[]) =>
      String(c[0]).endsWith(suffix)
    );
    expect(call).toBeDefined();
    return JSON.parse(call![1] as string);
  };

  it('creates Claude settings, shared env, and Cursor hooks when none exist', () => {
    mockExistsSync.mockReturnValue(false);
    installChronicleHook(REPO, HOOK, PROJECTS);

    const envCall = mockWriteFileSync.mock.calls.find((c: string[]) =>
      String(c[0]).endsWith('chronicle.env')
    );
    expect(envCall?.[1]).toContain(`CHRONICLE_REPO="${REPO}"`);
    expect(envCall?.[1]).toContain(`CHRONICLE_PROJECT="${PROJECTS}"`);

    const written = writtenJsonFor('settings.json');
    expect(written.env).toEqual(
      expect.objectContaining({
        CHRONICLE_REPO: REPO,
        CHRONICLE_PROJECT: PROJECTS
      })
    );
    expect((written.hooks as { Stop: unknown[] }).Stop[0]).toEqual(
      expect.objectContaining({
        hooks: [expect.objectContaining({ command: HOOK, async: true })]
      })
    );

    const cursorHooks = writtenJsonFor('hooks.json');
    expect(cursorHooks.version).toBe(1);
    expect(
      (cursorHooks.hooks as { sessionStart: unknown[] }).sessionStart[0]
    ).toEqual(
      expect.objectContaining({
        command: '/base/rosetta_chronicle/hooks/cursor-session-start.sh'
      })
    );
    expect((cursorHooks.hooks as { stop: unknown[] }).stop[0]).toEqual(
      expect.objectContaining({
        command: '/base/rosetta_chronicle/hooks/cursor-stop-append.sh',
        loop_limit: null
      })
    );
    expect(mockMkdirSync).toHaveBeenCalled();
  });

  it('merges into an existing settings file preserving other keys', () => {
    mockExistsSync.mockImplementation((p: string) =>
      String(p).endsWith('settings.json')
    );
    mockReadFileSync.mockImplementation((p: string) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({ model: 'sonnet', env: { EXISTING: '1' } });
      }
      return '{}';
    });
    installChronicleHook(REPO, HOOK, PROJECTS);
    const written = writtenJsonFor('settings.json');
    expect(written.model).toBe('sonnet');
    expect((written.env as Record<string, string>)['EXISTING']).toBe('1');
    expect((written.env as Record<string, string>)['CHRONICLE_REPO']).toBe(
      REPO
    );
  });

  it('replaces an existing chronicle stop hook without duplicating', () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: HOOK, async: true }] }]
      }
    };
    mockExistsSync.mockImplementation((p: string) =>
      String(p).endsWith('settings.json')
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));
    installChronicleHook(REPO, HOOK, PROJECTS);
    const written = writtenJsonFor('settings.json');
    expect((written.hooks as { Stop: unknown[] }).Stop).toHaveLength(1);
  });

  it('preserves non-chronicle stop hooks when adding the chronicle one', () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/other/hook.sh' }] }]
      }
    };
    mockExistsSync.mockImplementation((p: string) =>
      String(p).endsWith('settings.json')
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));
    installChronicleHook(REPO, HOOK, PROJECTS);
    const written = writtenJsonFor('settings.json');
    expect((written.hooks as { Stop: unknown[] }).Stop).toHaveLength(2);
  });

  it('skips Claude settings write when settings cannot be parsed but still writes env + Cursor hooks', () => {
    mockExistsSync.mockImplementation((p: string) =>
      String(p).endsWith('settings.json')
    );
    mockReadFileSync.mockReturnValue('not valid json {{{');
    expect(() => installChronicleHook(REPO, HOOK, PROJECTS)).not.toThrow();
    const settingsWrites = mockWriteFileSync.mock.calls.filter((c: string[]) =>
      String(c[0]).endsWith('settings.json')
    );
    expect(settingsWrites).toHaveLength(0);
    expect(
      mockWriteFileSync.mock.calls.some((c: string[]) =>
        String(c[0]).endsWith('chronicle.env')
      )
    ).toBe(true);
    expect(
      mockWriteFileSync.mock.calls.some((c: string[]) =>
        String(c[0]).endsWith('hooks.json')
      )
    ).toBe(true);
  });

  it('logs a warning and does not throw when writeFileSync fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(() => installChronicleHook(REPO, HOOK, PROJECTS)).not.toThrow();
  });
});

describe('installCursorChronicleHooks', () => {
  const SESSION_START = '/base/rosetta_chronicle/hooks/cursor-session-start.sh';
  const STOP = '/base/rosetta_chronicle/hooks/cursor-stop-append.sh';

  const writtenHooks = (): {
    version: number;
    hooks: Record<string, Array<{ command: string }>>;
  } => {
    const call = mockWriteFileSync.mock.calls.find((c: string[]) =>
      String(c[0]).endsWith('hooks.json')
    );
    expect(call).toBeDefined();
    return JSON.parse(call![1] as string);
  };

  it('rewrites hooks from scratch when the existing file is malformed', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    expect(() =>
      installCursorChronicleHooks(SESSION_START, STOP)
    ).not.toThrow();

    const written = writtenHooks();
    expect(written.version).toBe(1);
    expect(written.hooks.sessionStart[0].command).toBe(SESSION_START);
    expect(written.hooks.stop[0].command).toBe(STOP);
  });

  it('preserves unrelated hooks and does not duplicate ours on re-run', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: '/other/telemetry.js' }],
          sessionStart: [{ command: SESSION_START }],
          stop: [{ command: '/other/stop.sh' }]
        }
      })
    );

    installCursorChronicleHooks(SESSION_START, STOP);

    const written = writtenHooks();
    expect(written.hooks.preToolUse[0].command).toBe('/other/telemetry.js');
    // Ours replaced, not duplicated.
    expect(
      written.hooks.sessionStart.filter(h => h.command === SESSION_START)
    ).toHaveLength(1);
    // Unrelated stop hook preserved alongside ours.
    expect(written.hooks.stop.map(h => h.command)).toEqual(
      expect.arrayContaining(['/other/stop.sh', STOP])
    );
  });

  it('defaults the version to 1 when the existing file has none', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ hooks: {} }));

    installCursorChronicleHooks(SESSION_START, STOP);

    expect(writtenHooks().version).toBe(1);
  });
});

describe('buildChronicleEngine', () => {
  const ENGINE = '/base/rosetta_chronicle';
  const DIST_CLI = '/base/rosetta_chronicle/dist/bin/cli.js';

  it('skips the build when dist/bin/cli.js already exists', () => {
    mockExistsSync.mockImplementation((p: string) => p === DIST_CLI);
    buildChronicleEngine(ENGINE);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('runs yarn build when dist/bin/cli.js is absent', () => {
    mockExistsSync.mockReturnValue(false);
    buildChronicleEngine(ENGINE);
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls).toContain('yarn build');
  });

  it('does not throw when yarn build fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error('build failed');
    });
    expect(() => buildChronicleEngine(ENGINE)).not.toThrow();
  });
});

describe('seedPersonalRepoFiles', () => {
  const REPO = '/base/rosetta_chronicle_example-user';
  const GITIGNORE = '/base/rosetta_chronicle_example-user/.gitignore';

  it('writes .gitignore and commits when it does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => p !== GITIGNORE);
    seedPersonalRepoFiles(REPO);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      GITIGNORE,
      'stop-hook.log\n'
    );
    const cmds = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(cmds).toContain('git add .gitignore');
    expect(cmds).toContain('git commit -m "chore: ignore stop-hook.log"');
    expect(cmds).toContain('git push');
  });

  it('skips when .gitignore already exists', () => {
    mockExistsSync.mockImplementation((p: string) => p === GITIGNORE);
    seedPersonalRepoFiles(REPO);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('does not throw when git operations fail', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error('no remote');
    });
    expect(() => seedPersonalRepoFiles(REPO)).not.toThrow();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      GITIGNORE,
      'stop-hook.log\n'
    );
  });
});

describe('provisionPersonalChronicle', () => {
  it('skips when no gh user can be resolved', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) throw new Error('no auth');
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    // Only the user resolution was attempted; no create/clone.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('skips create and clone when already cloned locally', () => {
    mockExecSync.mockReturnValue('example-user\n');
    mockExistsSync.mockReturnValue(true);
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((c: string) => c.includes('gh repo create'))).toBe(false);
    expect(calls.some((c: string) => c.includes('gh repo clone'))).toBe(false);
  });

  it('creates a private repo (seeded with a readme) then clones it when nothing exists', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('.default_branch')) return 'main\n';
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls).toContainEqual(
      expect.stringContaining(
        'gh repo create MyOrg/rosetta_chronicle_example-user --private'
      )
    );
    expect(calls.some((c: string) => c.includes('--add-readme'))).toBe(true);
    expect(calls).toContainEqual(
      expect.stringContaining(
        'gh repo clone MyOrg/rosetta_chronicle_example-user "/base/rosetta_chronicle_example-user"'
      )
    );
  });

  it('renames the default branch to main when create yields master', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('.default_branch')) return 'master\n';
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls).toContainEqual(
      expect.stringContaining('branches/master/rename -f new_name=main')
    );
  });

  it('does not rename when the default branch already matches', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('.default_branch')) return 'main\n';
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((c: string) => c.includes('/rename'))).toBe(false);
  });

  it('does not fail provisioning when default-branch normalization errors', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('.default_branch')) throw new Error('api error');
      return '';
    });
    expect(() =>
      provisionPersonalChronicle(config, '/base', 'MyOrg')
    ).not.toThrow();
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    // Clone still proceeds despite the normalization failure.
    expect(calls.some((c: string) => c.includes('gh repo clone'))).toBe(true);
  });

  it('swallows an existing remote repo (via repo view) and clones it', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) return 'exists';
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((c: string) => c.includes('gh repo create'))).toBe(false);
    expect(calls.some((c: string) => c.includes('gh repo clone'))).toBe(true);
  });

  it('swallows an "already exists" create race and still clones', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('gh repo create'))
        throw new Error('Name already exists on this account');
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((c: string) => c.includes('gh repo clone'))).toBe(true);
  });

  it('logs and returns cleanly when the clone step fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('gh repo create')) return '';
      if (cmd.includes('gh repo clone')) throw new Error('network error');
      return '';
    });
    expect(() =>
      provisionPersonalChronicle(config, '/base', 'MyOrg')
    ).not.toThrow();
  });

  it('aborts without cloning when create fails for a non-exists reason', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh api user')) return 'example-user\n';
      if (cmd.includes('gh repo view')) throw new Error('not found');
      if (cmd.includes('gh repo create'))
        throw new Error('insufficient permissions');
      return '';
    });
    provisionPersonalChronicle(config, '/base', 'MyOrg');
    const calls = mockExecSync.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((c: string) => c.includes('gh repo clone'))).toBe(false);
  });
});
