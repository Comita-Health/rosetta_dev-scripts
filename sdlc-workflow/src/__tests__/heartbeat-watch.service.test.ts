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
});
