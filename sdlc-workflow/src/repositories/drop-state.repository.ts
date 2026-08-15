import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { injectable } from 'inversify';
import { DropState, WorkflowError } from '../types';
import { sanitizeDropId } from '../utils/drop-id';

export interface IDropStateRepository {
  write(dropsDir: string, state: DropState): string;
  load(dropsDir: string, dropId: string): DropState;
  pathFor(dropsDir: string, dropId: string): string;
}

/**
 * Persist one drop's state under `<dropsDir>/<dropId>/drop.json`.
 * Resource access only — grain and merge policy live in DropService.
 */
@injectable()
export class DropStateRepository implements IDropStateRepository {
  pathFor(dropsDir: string, dropId: string): string {
    return path.join(dropsDir, sanitizeDropId(dropId), 'drop.json');
  }

  write(dropsDir: string, state: DropState): string {
    const filePath = this.pathFor(dropsDir, state.dropId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
    return filePath;
  }

  load(dropsDir: string, dropId: string): DropState {
    const filePath = this.pathFor(dropsDir, dropId);
    if (!existsSync(filePath)) {
      throw new WorkflowError(`drop not found: ${dropId}`, 'DROP_INVALID', [
        filePath
      ]);
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as DropState;
  }
}
