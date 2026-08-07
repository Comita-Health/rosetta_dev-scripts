import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverActivateScript,
  envForAddiWrite,
  isAddiLogin
} from '../utils/gh-auth';

jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

const execMock = execSync as jest.Mock;

describe('gh-auth (Addi write identity)', () => {
  afterEach(() => {
    execMock.mockReset();
  });

  describe('isAddiLogin', () => {
    it.each([
      'addi-m[bot]',
      'app/addi-m',
      'rosetta-s-addi-m[bot]',
      'app/rosetta-s-addi-m'
    ])('accepts %s', login => {
      expect(isAddiLogin(login)).toBe(true);
    });

    it('rejects a human login', () => {
      expect(isAddiLogin('Roustalski')).toBe(false);
    });
  });

  describe('discoverActivateScript', () => {
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(path.join(os.tmpdir(), 'gh-auth-home-'));
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('prefers SDLC_GH_ACTIVATE when the path exists', () => {
      const script = path.join(home, 'custom-activate.sh');
      writeFileSync(script, '#!/bin/bash\n');
      expect(
        discoverActivateScript(home, { SDLC_GH_ACTIVATE: script })
      ).toBe(script);
    });

    it('falls through to ~/.config/*/github-app-activate.sh', () => {
      const dir = path.join(home, '.config', 'comita');
      mkdirSync(dir, { recursive: true });
      const script = path.join(dir, 'github-app-activate.sh');
      writeFileSync(script, '#!/bin/bash\n');
      expect(discoverActivateScript(home, {})).toBe(script);
    });

    it('returns null when nothing is installed', () => {
      expect(discoverActivateScript(home, {})).toBeNull();
    });
  });

  describe('envForAddiWrite', () => {
    let home: string;
    let activate: string;
    let tokenScript: string;

    beforeEach(() => {
      home = mkdtempSync(path.join(os.tmpdir(), 'gh-auth-addi-'));
      const dir = path.join(home, '.config', 'comita');
      mkdirSync(dir, { recursive: true });
      activate = path.join(dir, 'github-app-activate.sh');
      tokenScript = path.join(dir, 'github-app-token.sh');
      writeFileSync(activate, '#!/bin/bash\n');
      writeFileSync(tokenScript, '#!/bin/bash\necho token\n');
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('reuses the current env when viewer is already Addi', () => {
      execMock.mockReturnValueOnce('addi-m[bot]\n');
      const base = { HOME: home, GH_TOKEN: 'already-addi', PATH: '/bin' };

      const env = envForAddiWrite(base, { home });

      expect(env.GH_TOKEN).toBe('already-addi');
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(String(execMock.mock.calls[0][0])).toContain('viewer');
    });

    it('mints an installation token when ambient auth is a human', () => {
      execMock
        .mockReturnValueOnce('Roustalski\n') // ambient viewer
        .mockReturnValueOnce('ghs_minted_token\n') // token script
        .mockReturnValueOnce('addi-m[bot]\n'); // viewer under minted token

      const env = envForAddiWrite({ HOME: home, PATH: '/bin' }, { home });

      expect(env.GH_TOKEN).toBe('ghs_minted_token');
      expect(env.GITHUB_TOKEN).toBe('ghs_minted_token');
      expect(String(execMock.mock.calls[1][0])).toContain('github-app-token.sh');
    });

    it('fails loud when no activate script exists', () => {
      const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'gh-auth-empty-'));
      try {
        execMock.mockReturnValueOnce('Roustalski\n');
        expect(() =>
          envForAddiWrite({ HOME: emptyHome }, { home: emptyHome })
        ).toThrow(expect.objectContaining({ code: 'GH_NOT_ADDI' }));
      } finally {
        rmSync(emptyHome, { recursive: true, force: true });
      }
    });

    it('fails loud when the minted token is still not Addi', () => {
      execMock
        .mockReturnValueOnce('Roustalski\n')
        .mockReturnValueOnce('ghs_bad\n')
        .mockReturnValueOnce('SomeoneElse\n');

      expect(() =>
        envForAddiWrite({ HOME: home }, { home })
      ).toThrow(expect.objectContaining({ code: 'GH_NOT_ADDI' }));
    });
  });
});
