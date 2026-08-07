import 'reflect-metadata';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

import { spawnSync } from 'child_process';
import {
  ChatMirrorNotificationChannel,
  DesktopNotificationChannel,
  NOTIFY_WAKE_ACTION_ID,
  NotifyWakeAction,
  type IWakeNotificationChannel
} from '../services/notify-wake.action';
import {
  WakeActionRegistry,
  type IWakeAction,
  type WakeActionContext
} from '../services/wake-action';
import type { WakeEvent } from '../types';

const spawnMock = spawnSync as jest.Mock;

const wake: WakeEvent = {
  id: 'a'.repeat(64),
  kind: 'pr-review',
  target: 'owner/repo#42',
  signal: 'approved:review-123',
  createdAt: '2026-08-07T12:00:00.000Z',
  prompt: 'PR approved',
  data: { reviewId: 123 },
  consumedBy: 'daemon'
};

const context = (event: WakeEvent = wake): WakeActionContext => ({
  workspaceRoot: '/tmp/workspace',
  wake: event,
  consumedBy: event.consumedBy ?? 'daemon'
});

describe('DesktopNotificationChannel', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('sends an osascript banner titled with the wake kind', async () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    await new DesktopNotificationChannel().notify(wake);

    expect(spawnMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('SDLC wake: pr-review')],
      { encoding: 'utf-8' }
    );
    expect(spawnMock.mock.calls[0][1][1]).toContain(
      'display notification "PR approved"'
    );
  });

  it('falls back to the signal and escapes quotes and backslashes', async () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    await new DesktopNotificationChannel().notify({
      ...wake,
      prompt: undefined,
      signal: 'say "hi" \\ now'
    });

    expect(spawnMock.mock.calls[0][1][1]).toContain(
      'display notification "say \\"hi\\" \\\\ now"'
    );
  });

  it('truncates a long body to the banner limit', async () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    await new DesktopNotificationChannel().notify({
      ...wake,
      prompt: 'x'.repeat(400)
    });

    expect(spawnMock.mock.calls[0][1][1]).toContain(`"${'x'.repeat(220)}"`);
  });

  it('is a no-op when osascript is missing (non-macOS host)', async () => {
    const missing: NodeJS.ErrnoException = new Error('spawn osascript ENOENT');
    missing.code = 'ENOENT';
    spawnMock.mockReturnValue({ error: missing, status: null });

    await expect(
      new DesktopNotificationChannel().notify(wake)
    ).resolves.toBeUndefined();
  });

  it('throws the stderr of a failed banner', async () => {
    spawnMock.mockReturnValue({ status: 1, stderr: ' not authorized \n' });

    await expect(new DesktopNotificationChannel().notify(wake)).rejects.toThrow(
      'not authorized'
    );
  });

  it('throws the spawn error message when a failure produced no stderr', async () => {
    spawnMock.mockReturnValue({
      status: null,
      stderr: '',
      error: new Error('osascript blew up')
    });

    await expect(new DesktopNotificationChannel().notify(wake)).rejects.toThrow(
      'osascript blew up'
    );
  });

  it('reports the exit status when there is neither stderr nor an error', async () => {
    // `spawnSync` omits stderr when the child is killed by a signal.
    spawnMock.mockReturnValue({ status: 137 });

    await expect(new DesktopNotificationChannel().notify(wake)).rejects.toThrow(
      'osascript exited 137'
    );
  });
});

describe('ChatMirrorNotificationChannel', () => {
  it('writes a parseable sentinel line for the watching agent', async () => {
    const lines: string[] = [];
    await new ChatMirrorNotificationChannel(line => lines.push(line)).notify(
      wake
    );

    expect(lines).toHaveLength(1);
    const [prefix, payload] = [
      lines[0].slice(0, lines[0].indexOf(' ')),
      lines[0].slice(lines[0].indexOf(' ') + 1)
    ];
    expect(prefix).toBe('AGENT_LOOP_WAKE_pr-review');
    expect(JSON.parse(payload)).toEqual({
      id: wake.id,
      kind: 'pr-review',
      target: 'owner/repo#42',
      signal: 'approved:review-123',
      prompt: 'PR approved',
      data: { reviewId: 123 },
      createdAt: '2026-08-07T12:00:00.000Z',
      consumedBy: 'daemon'
    });
  });

  it('defaults an absent prompt and data to empty values', async () => {
    const lines: string[] = [];
    await new ChatMirrorNotificationChannel(line => lines.push(line)).notify({
      ...wake,
      prompt: undefined,
      data: undefined
    });

    expect(JSON.parse(lines[0].slice(lines[0].indexOf(' ') + 1))).toMatchObject({
      prompt: '',
      data: {}
    });
  });

  it('writes to stdout when no writer is injected', async () => {
    const written: unknown[] = [];
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(chunk => {
        written.push(chunk);
        return true;
      });
    try {
      await new ChatMirrorNotificationChannel().notify(wake);
    } finally {
      write.mockRestore();
    }

    expect(written).toEqual([
      expect.stringMatching(/^AGENT_LOOP_WAKE_pr-review \{.*\}\n$/s)
    ]);
  });
});

describe('NotifyWakeAction', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('reports ok when every channel succeeds', async () => {
    const action = new NotifyWakeAction([
      { id: 'one', notify: async () => undefined },
      { id: 'two', notify: async () => undefined }
    ]);

    await expect(action.execute(context())).resolves.toEqual({ ok: true });
    expect(action.id).toBe(NOTIFY_WAKE_ACTION_ID);
  });

  it('reports the single failing channel verbatim', async () => {
    const action = new NotifyWakeAction([
      {
        id: 'desktop',
        notify: async () => {
          throw new Error('banner exploded');
        }
      },
      { id: 'chat-mirror', notify: async () => undefined }
    ]);

    await expect(action.execute(context())).resolves.toEqual({
      ok: false,
      channelId: 'desktop',
      error: 'banner exploded'
    });
  });

  it('folds multiple channel failures into one message keyed by the first', async () => {
    const throwing = (
      id: string,
      error: unknown
    ): IWakeNotificationChannel => ({
      id,
      notify: async () => {
        throw error;
      }
    });
    const action = new NotifyWakeAction([
      throwing('desktop', new Error('banner exploded')),
      throwing('chat-mirror', 'pipe closed')
    ]);

    await expect(action.execute(context())).resolves.toEqual({
      ok: false,
      channelId: 'desktop',
      error: 'desktop: banner exploded; chat-mirror: pipe closed'
    });
  });

  it('uses the desktop and chat mirrors by default', async () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const written: unknown[] = [];
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(chunk => {
        written.push(chunk);
        return true;
      });
    try {
      await expect(new NotifyWakeAction().execute(context())).resolves.toEqual({
        ok: true
      });
    } finally {
      write.mockRestore();
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
  });
});

describe('WakeActionRegistry', () => {
  const probe: IWakeAction = {
    id: 'probe',
    execute: async () => ({ ok: true })
  };

  it('registers, looks up, and lists actions', () => {
    const registry = new WakeActionRegistry();
    registry.register(probe);

    expect(registry.get('probe')).toBe(probe);
    expect(registry.list()).toEqual([probe]);
  });

  it('returns null for an unregistered id', () => {
    expect(new WakeActionRegistry().get('nope')).toBeNull();
  });

  it('replaces an action registered under the same id', () => {
    const registry = new WakeActionRegistry();
    const replacement: IWakeAction = {
      id: 'probe',
      execute: async () => ({ ok: false, error: 'nope' })
    };
    registry.register(probe);
    registry.register(replacement);

    expect(registry.list()).toEqual([replacement]);
  });

  it('rejects an action without a usable id', () => {
    const registry = new WakeActionRegistry();

    expect(() => registry.register({ ...probe, id: '  ' })).toThrow(TypeError);
    expect(() =>
      registry.register({ ...probe, id: 7 as unknown as string })
    ).toThrow(/non-empty string/);
    expect(registry.list()).toEqual([]);
  });
});
