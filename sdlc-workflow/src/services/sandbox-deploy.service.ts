import { inject, injectable } from 'inversify';
import type { IContractRepository } from '../repositories/contract.repository';
import type { IDeployRecordRepository } from '../repositories/deploy-record.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { DeployTrigger, GateVerdict, SandboxRecord } from '../types';
import { ghEnv } from '../utils/gh-cli';

export interface SandboxDeployInput {
  /** Worktree of the task branch — contract and commands run from here. */
  worktreePath: string;
  /** Commit SHA being deployed; exported as SDLC_SANDBOX_SHA. */
  sha: string;
  /**
   * Base the deployed SHA should be compared against — the task's integration
   * tip or the gate base (SPEC-PRD-0011-P4 T-01). Exported as
   * `SDLC_SANDBOX_BASE_SHA` so a repo-owned deploy script can decide from
   * `base..head` whether anything deployable changed at all.
   *
   * @remarks
   * The engine stays path-agnostic on purpose: it publishes the range and the
   * repo owns the policy. A path filter baked in here would be wrong for the
   * next consumer, and a repo's own filters (`.github/path-filters.yml`) apply
   * to `push`, not to a `workflow_dispatch` the engine triggers.
   */
  baseSha?: string;
  /** Prior sandbox record from run state, for SHA idempotency. */
  previous?: SandboxRecord;
  /**
   * Deploy-ledger identity for this dispatch (SPEC-PRD-0022-P1 T-01/T-02/T-03).
   * Present → the deploy is recorded, and dedup and race avoidance apply.
   * Absent → no ledger, and every call deploys as it always did.
   */
  ledger?: DeployLedgerRef;
}

export interface DeployLedgerRef {
  runsDir: string;
  runId: string;
  /** `git rev-parse <sha>^{tree}` — the dedup key. */
  contentSha: string;
  trigger: DeployTrigger;
  taskId?: string;
}

export interface SandboxDeployOutcome {
  verdict: GateVerdict;
  record?: SandboxRecord;
  /** Health command output — the verifier agent's sandbox interface. */
  healthReport?: string;
  /**
   * Workflow run URL the deploy script printed, when it printed one. The
   * engine cannot know the run id of a dispatch it did not make itself, so
   * this is captured from output rather than assumed (SPEC-PRD-0022-P1 T-01).
   */
  workflowRef?: string;
  /** True when the deploy command was skipped because the SHA was live. */
  alreadyDeployed?: boolean;
  /**
   * Commit SHA whose deploy this call reused instead of dispatching its own
   * (SPEC-PRD-0022-P1 T-02). Set only on the reuse path.
   */
  reusedFrom?: string;
}

/**
 * First GitHub Actions run URL in deploy output. Repo-owned deploy scripts
 * commonly echo the dispatched run; when one does, the ledger can point at it.
 */
const workflowRefFrom = (output: string): string | undefined =>
  /https:\/\/github\.com\/[^\s"']+\/actions\/runs\/\d+/.exec(output)?.[0];

/**
 * SPEC-PRD-0011-P2 T-03: deploy the task branch build to the sandbox via
 * the repo-owned contract (`.sdlc/environments.json` → `sandbox`).
 *
 * - Idempotent per SHA: a SHA already recorded healthy skips the deploy
 *   command and re-verifies health only.
 * - Idempotent per *content* when a ledger is supplied (SPEC-PRD-0022-P1):
 *   content already live under another commit is reused, and content another
 *   trigger is already deploying is never dispatched a second time.
 * - Health must report the deployed SHA: the health command's output has
 *   to contain `SDLC_SANDBOX_SHA` verbatim.
 * - No path beyond the sandbox: the contract repository exposes only the
 *   sandbox entry, and this service takes no environment parameter.
 */
export interface ISandboxDeployService {
  deploy(input: SandboxDeployInput): Promise<SandboxDeployOutcome>;
}

@injectable()
export class SandboxDeployService implements ISandboxDeployService {
  constructor(
    @inject(WORKFLOW_TOKENS.ContractRepository)
    private readonly _contractRepo: IContractRepository,
    @inject(WORKFLOW_TOKENS.ShellCommandRepository)
    private readonly _shellRepo: IShellCommandRepository,
    @inject(WORKFLOW_TOKENS.DeployRecordRepository)
    private readonly _deployRecords: IDeployRecordRepository
  ) {}

  async deploy(input: SandboxDeployInput): Promise<SandboxDeployOutcome> {
    const now = (): string => new Date().toISOString();
    const contract = this._contractRepo.loadSandbox(input.worktreePath);
    if (contract === null) {
      return {
        verdict: {
          gate: 'sandbox',
          outcome: 'blocked',
          wouldEscalate: false,
          reasons: [
            'no sandbox contract (.sdlc/environments.json → sandbox) in the repo'
          ],
          recordedAt: now()
        }
      };
    }

    const known =
      input.ledger === undefined
        ? null
        : this._deployRecords.latestForContent(
            input.ledger.runsDir,
            input.ledger.runId,
            input.ledger.contentSha
          );

    // T-02: content already live under a *different* commit is reused
    // outright — no deploy and no health probe. The live app answers with the
    // commit SHA it was deployed from, so probing it for this SHA would fail
    // on byte-identical content. The ledger record is the evidence.
    if (
      input.ledger !== undefined &&
      known?.status === 'healthy' &&
      known.commitSha !== input.sha
    ) {
      this._deployRecords.recordReuse({
        ...input.ledger,
        commitSha: input.sha,
        reusedFrom: known.commitSha
      });
      return {
        verdict: {
          gate: 'sandbox',
          outcome: 'pass',
          wouldEscalate: false,
          reasons: [
            `content ${input.ledger.contentSha.slice(0, 12)} is already deployed ` +
              `and healthy from ${known.commitSha.slice(0, 12)} — deploy reused`
          ],
          recordedAt: now()
        },
        record: {
          sha: input.sha,
          status: 'healthy',
          contentSha: input.ledger.contentSha,
          recordedAt: now()
        },
        reusedFrom: known.commitSha
      };
    }

    // T-03: someone else is already deploying this content — most often a
    // push-triggered workflow racing a phase boundary. Dispatching a second
    // job cannot make the target converge faster and can thrash it, so this
    // call only observes health. If the deploy has not landed yet the verdict
    // is red and a later wave retries; it never dispatches to find out.
    const inFlight = known?.status === 'in-flight';

    // Only set BASE_SHA when we actually know it. An empty value looks "set"
    // to a shell test, so a script would take the range path with no range and
    // decide nothing changed — the worst possible failure for a deploy gate.
    const env: Record<string, string> =
      input.baseSha === undefined || input.baseSha.length === 0
        ? { SDLC_SANDBOX_SHA: input.sha }
        : {
            SDLC_SANDBOX_SHA: input.sha,
            SDLC_SANDBOX_BASE_SHA: input.baseSha
          };

    // The deploy and health commands are repo-owned scripts that call gh
    // (workflow dispatch, run watch). They would otherwise inherit this
    // process's token, which in a detached run is whatever the operator
    // exported at launch and has expired long before a later task deploys -
    // surfacing as "deploy command failed" for a workflow that in fact
    // succeeded. Handing them a refreshed credential keeps the gate's
    // verdict about the deploy rather than about our own auth.
    const creds = ghEnv(input.worktreePath);
    if (typeof creds.GH_TOKEN === 'string' && creds.GH_TOKEN.length > 0) {
      env.GH_TOKEN = creds.GH_TOKEN;
      env.GITHUB_TOKEN = creds.GH_TOKEN;
    }
    const timeoutMs = contract.timeoutMinutes * 60_000;
    // Either source of truth counts as live. Run state keeps only the most
    // recent deploy, so a second trigger for content this run already shipped
    // would otherwise redeploy it purely because a later deploy overwrote the
    // record — the ledger remembers per content.
    const sameShaLive =
      (input.previous?.sha === input.sha &&
        input.previous.status === 'healthy') ||
      (known?.status === 'healthy' && known.commitSha === input.sha);
    const alreadyDeployed = sameShaLive || inFlight;
    let workflowRef: string | undefined;

    // Marked before dispatch, not after: the window a concurrent trigger has
    // to see is precisely the one where the deploy is running.
    const begun =
      input.ledger === undefined || alreadyDeployed
        ? undefined
        : this._deployRecords.begin({ ...input.ledger, commitSha: input.sha });
    const contentSha = input.ledger?.contentSha;
    const settle = (status: 'healthy' | 'failed'): void => {
      if (begun === undefined || input.ledger === undefined) return;
      this._deployRecords.finish(
        input.ledger.runsDir,
        input.ledger.runId,
        begun,
        { status, workflowRef }
      );
    };

    if (!alreadyDeployed) {
      const deploy = await this._shellRepo.run(
        input.worktreePath,
        contract.deployCommand,
        env,
        timeoutMs
      );
      workflowRef = workflowRefFrom(deploy.output);
      if (!deploy.ok) {
        settle('failed');
        return {
          verdict: {
            gate: 'sandbox',
            outcome: 'breach',
            wouldEscalate: true,
            reasons: ['deploy command failed'],
            transcript: deploy.output.slice(0, 4000),
            recordedAt: now()
          },
          record: {
            sha: input.sha,
            status: 'failed',
            contentSha,
            recordedAt: now()
          },
          workflowRef
        };
      }
    }

    const health = await this._shellRepo.run(
      input.worktreePath,
      contract.healthCommand,
      env,
      timeoutMs
    );
    if (!health.ok || !health.output.includes(input.sha)) {
      settle('failed');
      return {
        verdict: {
          gate: 'sandbox',
          outcome: 'breach',
          wouldEscalate: true,
          reasons: [
            inFlight
              ? `a deploy of this content is in flight and has not reported ${input.sha} yet`
              : health.ok
                ? `health output does not report deployed SHA ${input.sha}`
                : 'health command failed'
          ],
          transcript: health.output.slice(0, 4000),
          recordedAt: now()
        },
        record: {
          sha: input.sha,
          status: 'failed',
          contentSha,
          recordedAt: now()
        },
        workflowRef,
        alreadyDeployed
      };
    }

    settle('healthy');
    return {
      verdict: {
        gate: 'sandbox',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: [this.passReason(input.sha, { inFlight, sameShaLive })],
        recordedAt: now()
      },
      record: {
        sha: input.sha,
        status: 'healthy',
        contentSha,
        recordedAt: now()
      },
      healthReport: health.output,
      workflowRef,
      alreadyDeployed
    };
  }

  /**
   * Why the sandbox passed, in the operator's terms. Three passes look
   * identical in the verdict outcome and mean different things about spend, so
   * the reason has to distinguish them.
   */
  private passReason(
    sha: string,
    skip: { inFlight: boolean; sameShaLive: boolean }
  ): string {
    if (skip.inFlight) {
      return `another trigger's deploy of this content is live — dispatch skipped, health verified at ${sha}`;
    }
    if (skip.sameShaLive) {
      return `already deployed at ${sha} — deploy skipped, health verified`;
    }
    return `deployed and healthy at ${sha}`;
  }
}
