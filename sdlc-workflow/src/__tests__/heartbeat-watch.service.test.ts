import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { HeartbeatWatchService } from '../services/heartbeat-watch.service';

describe('HeartbeatWatchService', () => {
  it('mirrors new heartbeat lines into the monitor log', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-watch-'));
    const heartbeatPath = path.join(dir, 'heartbeat.jsonl');
    const monitorPath = path.join(dir, 'monitor.log');
    writeFileSync(heartbeatPath, '');

    const watch = new HeartbeatWatchService();
    watch.start({ heartbeatPath, monitorPath, pollMs: 50 });

    writeFileSync(
      heartbeatPath,
      `${JSON.stringify({ ts: 't', runId: 'r', step: 'implementation' })}\n`
    );

    await new Promise(r => setTimeout(r, 120));
    watch.stop();

    const monitor = readFileSync(monitorPath, 'utf8');
    expect(monitor).toContain('[hb-watch] started');
    expect(monitor).toContain('[hb #1');
    expect(monitor).toContain('"step":"implementation"');
    expect(readFileSync(`${monitorPath}.count`, 'utf8')).toBe('1');
  });

  it('tolerates a missing heartbeat file and a truncated/rewritten log', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-watch-'));
    const heartbeatPath = path.join(dir, 'heartbeat.jsonl');
    const monitorPath = path.join(dir, 'monitor.log');

    const watch = new HeartbeatWatchService();
    watch.start({ heartbeatPath, monitorPath, pollMs: 40 });
    await new Promise(r => setTimeout(r, 90));

    writeFileSync(heartbeatPath, '{"step":"a"}\n{"step":"b"}\n');
    await new Promise(r => setTimeout(r, 90));

    // Truncate (size < offset) then rewrite
    writeFileSync(heartbeatPath, '{"step":"c"}\n');
    await new Promise(r => setTimeout(r, 90));
    watch.stop();

    const monitor = readFileSync(monitorPath, 'utf8');
    expect(monitor).toContain('"step":"a"');
    expect(monitor).toContain('"step":"c"');
  });

  it('note appends operator lines without requiring start', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-watch-'));
    const monitorPath = path.join(dir, 'nested', 'monitor.log');
    const watch = new HeartbeatWatchService();
    watch.note(monitorPath, 'hello');
    expect(readFileSync(monitorPath, 'utf8')).toContain('hello');
  });
});
