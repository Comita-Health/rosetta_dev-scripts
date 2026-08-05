import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'fs';
import { randomBytes } from 'crypto';

/**
 * Write `contents` to `file` so a reader never observes a partial result and
 * a crash never destroys the previous version (SPEC-PRD-0021-P1 T-01).
 *
 * The sequence is write-temp → `fsync` → `rename`. `rename(2)` is atomic
 * within a filesystem, so the target is only ever the old bytes or all the
 * new ones. The `fsync` is what makes that guarantee survive power loss
 * rather than merely surviving a process kill: without it the rename can be
 * durable while the data it points at is not, which yields a valid-looking
 * file full of zeros.
 *
 * @remarks
 * The temp name carries the pid and random bytes, so two concurrent writers
 * cannot collide on the scratch file and produce a spliced result. This does
 * *not* make concurrent writes safe — last rename wins — which is why
 * `state.json` writes also take the run lock.
 *
 * The temp file is removed on failure. A leaked `*.tmp.*` after a hard kill
 * is inert: readers only ever open the target path.
 */
export const writeFileAtomic = (file: string, contents: string): void => {
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx');
    try {
      writeAll(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up — the open itself failed.
    }
    throw err;
  }
};

/**
 * `writeSync` may write fewer bytes than requested on some platforms, and a
 * short write here would produce exactly the truncated file this module
 * exists to prevent.
 */
const writeAll = (fd: number, contents: string): void => {
  const buffer = Buffer.from(contents, 'utf-8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written);
  }
};
