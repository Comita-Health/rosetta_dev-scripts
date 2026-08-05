import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  IRunQueueRepository,
  QueuedLaunchRecord,
  RunQueueRepository
} from '../repositories/run-queue.repository';

const record = (
  specPath: string,
  overrides: Partial<Omit<QueuedLaunchRecord, 'queuedAt'>> = {}
): Omit<QueuedLaunchRecord, 'queuedAt'> => ({
  specPath,
  repoPath: '/repo',
  runsDir: '',
  argv: ['node', 'src/index.ts', 'run', '--spec', specPath, '--supervise'],
  execArgv: [],
  execPath: process.execPath,
  cwd: '/repo',
  ...overrides
});

describe('RunQueueRepository (T-02 durable launch queue)', () => {
  let runsDir: string;
  let repo: IRunQueueRepository;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-queue-'));
    repo = new RunQueueRepository();
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('writes a well-formed FIFO record as <runsDir>/queue/1.json', () => {
    const result = repo.enqueue(runsDir, record('/specs/a.md'));

    expect(result).toEqual({
      deduped: false,
      path: path.join(runsDir, 'queue', '1.json'),
      seq: 1
    });
    expect(existsSync(result.path)).toBe(true);

    const entries = repo.list(runsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].record.specPath).toBe('/specs/a.md');
    expect(typeof entries[0].record.queuedAt).toBe('string');
  });

  it('assigns ascending sequence numbers in FIFO order across enqueues', () => {
    repo.enqueue(runsDir, record('/specs/a.md'));
    repo.enqueue(runsDir, record('/specs/b.md'));
    repo.enqueue(runsDir, record('/specs/c.md'));

    const entries = repo.list(runsDir);
    expect(entries.map(entry => entry.seq)).toEqual([1, 2, 3]);
    expect(entries.map(entry => entry.record.specPath)).toEqual([
      '/specs/a.md',
      '/specs/b.md',
      '/specs/c.md'
    ]);
  });

  it('dedups a second enqueue for the same spec path without writing a new file', () => {
    const first = repo.enqueue(runsDir, record('/specs/a.md'));
    const second = repo.enqueue(
      runsDir,
      record('/specs/a.md', { repoPath: '/different-repo' })
    );

    expect(second).toEqual({ deduped: true, path: first.path, seq: 1 });
    expect(repo.list(runsDir)).toHaveLength(1);
  });

  it('dedups by resolved path — a relative and absolute spelling of the same file collide', () => {
    const absolute = path.join(runsDir, 'spec.md');
    repo.enqueue(runsDir, record(absolute));
    const second = repo.enqueue(
      runsDir,
      record(path.relative(process.cwd(), absolute))
    );

    expect(second.deduped).toBe(true);
    expect(repo.list(runsDir)).toHaveLength(1);
  });

  it('peek returns the oldest record, or null when the queue is empty', () => {
    expect(repo.peek(runsDir)).toBeNull();

    repo.enqueue(runsDir, record('/specs/a.md'));
    repo.enqueue(runsDir, record('/specs/b.md'));

    const head = repo.peek(runsDir);
    expect(head?.seq).toBe(1);
    expect(head?.record.specPath).toBe('/specs/a.md');
  });

  it('remove deletes a record by sequence number, advancing the FIFO head', () => {
    repo.enqueue(runsDir, record('/specs/a.md'));
    repo.enqueue(runsDir, record('/specs/b.md'));

    repo.remove(runsDir, 1);

    expect(repo.list(runsDir).map(entry => entry.record.specPath)).toEqual([
      '/specs/b.md'
    ]);
    expect(repo.peek(runsDir)?.record.specPath).toBe('/specs/b.md');
  });

  it('remove is a no-op when the sequence number is already gone', () => {
    repo.enqueue(runsDir, record('/specs/a.md'));
    expect(() => repo.remove(runsDir, 999)).not.toThrow();
    expect(repo.list(runsDir)).toHaveLength(1);
  });

  it('list returns an empty array when the queue directory does not exist', () => {
    expect(repo.list(path.join(runsDir, 'never-created'))).toEqual([]);
  });

  it('re-enqueuing while other records remain does not reuse a live sequence number', () => {
    repo.enqueue(runsDir, record('/specs/a.md'));
    repo.enqueue(runsDir, record('/specs/b.md'));
    repo.remove(runsDir, 1);
    const result = repo.enqueue(runsDir, record('/specs/c.md'));

    expect(result.seq).toBe(3);
  });
});
