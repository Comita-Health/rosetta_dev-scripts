import { checkPrerequisites } from '../services/prerequisites.service';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';

const mockExecSync = execSync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('checkPrerequisites', () => {
  it('returns true when all required tools are present and gh is authenticated', () => {
    mockExecSync.mockReturnValue('v24.0.0');
    expect(checkPrerequisites()).toBe(true);
  });

  it('returns false when a required tool is missing', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('node')) throw new Error('not found');
      if (cmd === 'gh auth status') return '';
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(false);
  });

  it('returns false when gh is not authenticated', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'gh auth status') throw new Error('not authenticated');
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(false);
  });

  it('returns false when Node version is below minimum', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('node')) return 'v18.0.0';
      if (cmd === 'gh auth status') return '';
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(false);
  });

  it('still passes when optional tool (fzf) is missing', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('fzf')) throw new Error('not found');
      if (cmd === 'gh auth status') return '';
      if (cmd.startsWith('claude') || cmd.startsWith('agent'))
        throw new Error('not found');
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(true);
  });

  it('still passes when neither Claude Code nor Cursor Agent CLI is installed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'gh auth status') return '';
      if (cmd.startsWith('claude') || cmd.startsWith('agent'))
        throw new Error('not found');
      if (cmd.startsWith('fzf')) throw new Error('not found');
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(true);
  });

  it('still passes when only Cursor Agent CLI is present', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'gh auth status') return '';
      if (cmd.startsWith('claude')) throw new Error('not found');
      if (cmd.startsWith('agent')) return '2026.7.0';
      if (cmd.startsWith('fzf')) throw new Error('not found');
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(true);
  });

  it('handles version output with no decimal (uses full string as version)', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'gh auth status') return '';
      if (cmd.startsWith('claude') || cmd.startsWith('agent'))
        throw new Error('not found');
      return '24';
    });
    expect(checkPrerequisites()).toBe(true);
  });

  it('returns false when bun version is below minimum', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('bun')) return '1.0.0';
      if (cmd === 'gh auth status') return '';
      if (cmd.startsWith('claude') || cmd.startsWith('agent'))
        throw new Error('not found');
      return 'v24.0.0';
    });
    expect(checkPrerequisites()).toBe(false);
  });
});
