import {
  layDownRootConfig,
  layDownProjectConfig
} from '../services/config-files.service';

jest.mock('fs', () => ({
  cpSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

import {
  cpSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'fs';
import path from 'path';

const mockCpSync = cpSync as jest.Mock;
const mockMkdirSync = mkdirSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockReaddirSync = readdirSync as jest.Mock;
const mockReadFileSync = readFileSync as jest.Mock;
const mockWriteFileSync = writeFileSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('layDownRootConfig', () => {
  it('skips when root template dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    layDownRootConfig('/base');
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it('copies Claude + Cursor root config when all sources exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((p: string) => {
      if (p.endsWith('.cursor')) return ['cli.json', 'skills'];
      if (p.endsWith(`${path.sep}rules`))
        return [
          'architecture-hsr.md',
          'code-style.md',
          'inline-docs.md',
          'sdlc-run-supervise.md',
          'pr-approve-watch.md'
        ];
      if (p.endsWith(`${path.sep}commands`))
        return ['review.md', 'add-repo.md', 'sdlc-status.md', 'sdlc-run.md'];
      return [];
    });
    mockReadFileSync.mockReturnValue('# rule body\n');

    layDownRootConfig('/base');

    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining('CLAUDE.md'),
      path.join('/base', 'CLAUDE.md')
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining('AGENTS.md'),
      path.join('/base', 'AGENTS.md')
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      path.join('/base', '.claude'),
      { recursive: true }
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining(`${path.sep}skills`),
      path.join('/base', '.cursor', 'skills'),
      { recursive: true }
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'architecture-hsr.mdc'),
      expect.stringContaining('alwaysApply: true')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'inline-docs.mdc'),
      expect.stringContaining('TSDoc / JSDoc bar')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'sdlc-run-supervise.mdc'),
      expect.stringContaining('background-supervise sdlc-workflow runs')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'pr-approve-watch.mdc'),
      expect.stringContaining('Approve proceed signal')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'command-review.mdc'),
      expect.stringContaining('alwaysApply: false')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'command-sdlc-status.mdc'),
      expect.stringContaining('alwaysApply: false')
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'command-sdlc-run.mdc'),
      expect.stringContaining('alwaysApply: false')
    );
  });

  it('skips CLAUDE.md when source does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('CLAUDE.md'));
    mockReaddirSync.mockReturnValue([]);
    layDownRootConfig('/base');
    const calls: string[] = mockCpSync.mock.calls.map((c: string[]) => c[1]);
    expect(calls).not.toContain(path.join('/base', 'CLAUDE.md'));
  });

  it('uses the generic description for unknown rule stems and skips non-md files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((p: string) => {
      if (p.endsWith('.cursor')) return ['cli.json'];
      if (p.endsWith(`${path.sep}rules`)) return ['my-custom.md', 'notes.txt'];
      if (p.endsWith(`${path.sep}commands`)) return [];
      return [];
    });
    mockReadFileSync.mockReturnValue('# custom rule\n');

    layDownRootConfig('/base');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'my-custom.mdc'),
      expect.stringContaining('Rosetta rule: my-custom')
    );
    const written = mockWriteFileSync.mock.calls.map((c: string[]) => c[0]);
    expect(written.some((p: string) => p.includes('notes'))).toBe(false);
  });

  it('falls back to a generated description when a command file is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((p: string) => {
      if (p.endsWith(`${path.sep}commands`)) return ['deploy.md'];
      if (p.endsWith('.cursor')) return [];
      return [];
    });
    mockReadFileSync.mockReturnValue('\n');

    layDownRootConfig('/base');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/base', '.cursor', 'rules', 'command-deploy.mdc'),
      expect.stringContaining('Run the deploy workflow')
    );
  });

  it('mirrors nothing when .claude has no rules or commands dirs', () => {
    mockExistsSync.mockImplementation(
      (p: string) =>
        !p.endsWith(`${path.sep}rules`) && !p.endsWith(`${path.sep}commands`)
    );
    mockReaddirSync.mockReturnValue([]);

    layDownRootConfig('/base');

    const mdcWrites = mockWriteFileSync.mock.calls.filter((c: string[]) =>
      String(c[0]).endsWith('.mdc')
    );
    expect(mdcWrites).toHaveLength(0);
  });

  it('skips .claude/ when source does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.claude'));
    mockReaddirSync.mockReturnValue([]);
    layDownRootConfig('/base');
    const destinations: string[] = mockCpSync.mock.calls.map(
      (c: string[]) => c[1]
    );
    expect(destinations).not.toContain(path.join('/base', '.claude'));
  });
});

describe('layDownProjectConfig', () => {
  const project = { id: 'my-proj', dir: 'my-proj', repos: [], symlinks: [] };

  it('skips project with no matching template', () => {
    mockExistsSync.mockReturnValue(false);
    layDownProjectConfig('/base', [project]);
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it('copies template when it exists', () => {
    mockExistsSync.mockReturnValue(true);
    layDownProjectConfig('/base', [project]);
    expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/base', 'my-proj'), {
      recursive: true
    });
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining('my-proj.CLAUDE.md'),
      path.join('/base', 'my-proj', 'CLAUDE.md')
    );
  });

  it('handles mix of projects with and without templates', () => {
    const noTemplate = {
      id: 'no-template',
      dir: 'no-template',
      repos: [],
      symlinks: []
    };
    mockExistsSync.mockImplementation((p: string) => p.includes('my-proj'));
    layDownProjectConfig('/base', [project, noTemplate]);
    expect(mockCpSync).toHaveBeenCalledTimes(2);
  });

  it('copies extra files directory when it exists alongside the template', () => {
    mockExistsSync.mockReturnValue(true);
    layDownProjectConfig('/base', [project]);
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('projects', 'my-proj')),
      path.join('/base', 'my-proj'),
      { recursive: true }
    );
  });

  it('skips extra files directory when it does not exist', () => {
    mockExistsSync.mockImplementation(
      (p: string) => !p.endsWith(path.join('projects', 'my-proj'))
    );
    layDownProjectConfig('/base', [project]);
    const recursiveCalls = mockCpSync.mock.calls.filter(
      (c: unknown[]) => c[2] !== undefined
    );
    expect(recursiveCalls).toHaveLength(0);
  });
});
