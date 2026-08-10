import { injectable } from 'inversify';
import { runGh } from '../utils/gh-cli';

/**
 * Whether GitHub Actions already has a deploy of the named workflow for a
 * commit SHA that the engine did not start itself (typically a `push`
 * to the default/build branch).
 *
 * @remarks
 * SPEC-PRD-0022-P1 T-03's ledger only sees deploys the engine recorded. A
 * push-triggered Deploy Organization run is invisible until something
 * queries Actions — without that, phase-boundary dispatch races the push
 * into CloudFormation (`Cannot delete ChangeSet in status CREATE_IN_PROGRESS`).
 */
export type ExternalDeployState = 'in-flight' | 'succeeded' | 'absent';

export interface ExternalDeployObservation {
  state: ExternalDeployState;
  /** Actions run URL when one was found. */
  workflowRef?: string;
}

export interface IDeployObservationRepository {
  /**
   * Look up workflow runs for `sha` on `workflow` (file name or workflow
   * name, as accepted by `gh run list --workflow`).
   *
   * Fail-open: a gh/API error returns `absent` so a flaky Actions query
   * cannot strand delivery — the worst case is one redundant dispatch.
   */
  observe(
    repoPath: string,
    sha: string,
    workflow: string
  ): ExternalDeployObservation;
}

interface GhWorkflowRun {
  status: string;
  conclusion: string | null;
  url: string;
  event: string;
}

const IN_FLIGHT = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested'
]);

@injectable()
export class DeployObservationRepository implements IDeployObservationRepository {
  observe(
    repoPath: string,
    sha: string,
    workflow: string
  ): ExternalDeployObservation {
    if (workflow.trim().length === 0 || sha.trim().length === 0) {
      return { state: 'absent' };
    }

    let raw: string;
    try {
      // Prefer commit filter over branch: phase-boundary worktrees sit on
      // sdlc/* refs while the push deploy landed on build-env/* for the
      // same head SHA.
      raw = runGh(
        repoPath,
        `gh run list --workflow ${shellQuote(workflow)} --commit ${shellQuote(sha)} --limit 20 --json status,conclusion,url,event`
      );
    } catch {
      return { state: 'absent' };
    }

    let runs: GhWorkflowRun[];
    try {
      runs = JSON.parse(raw) as GhWorkflowRun[];
    } catch {
      return { state: 'absent' };
    }
    if (!Array.isArray(runs) || runs.length === 0) {
      return { state: 'absent' };
    }

    const inFlight = runs.find(run => IN_FLIGHT.has(run.status));
    if (inFlight !== undefined) {
      return {
        state: 'in-flight',
        workflowRef: nonemptyUrl(inFlight.url)
      };
    }

    const succeeded = runs.find(
      run => run.status === 'completed' && run.conclusion === 'success'
    );
    if (succeeded !== undefined) {
      return {
        state: 'succeeded',
        workflowRef: nonemptyUrl(succeeded.url)
      };
    }

    return { state: 'absent' };
  }
}

const nonemptyUrl = (url: string | undefined): string | undefined =>
  typeof url === 'string' && url.length > 0 ? url : undefined;

/**
 * Single-quote for safe interpolation into the gh argv string that
 * `runGh` passes to the shell. Workflow file names are
 * `[A-Za-z0-9._-]+` in practice; quoting still covers spaces/names.
 */
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;
