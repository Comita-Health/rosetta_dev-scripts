export interface WorkflowInput {
  prdId: string; // e.g. 'PRD-0011'
  repoPath: string; // target repo the spec is written into
  docsDir: string; // directory holding PRD markdown files
  phase: number;
  budgetK: number;
}

export interface PrdRolloutPhase {
  number: number;
  title: string;
  description: string;
}

export interface ParsedPrd {
  id: string;
  title: string;
  status: string;
  owner: string;
  goals: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  rolloutPhases: PrdRolloutPhase[];
}

// PRD-0011 §4 contracts
export interface ProductStory {
  id: string; // e.g. 'S-01'
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  acceptanceCriteria: string[];
}

export type Complexity = 'S' | 'M' | 'L';

export interface SpecTask {
  id: string; // e.g. 'T-01'
  storyId: string;
  phase: number;
  title: string;
  engineeringNotes: string;
  complexity: Complexity;
  dependsOn: string[]; // task IDs
  acceptanceCriteria: string[]; // each tagged 'test:' | 'agent:' | 'manual:'
}

export interface Envelope {
  allowedPaths: string[];
  forbiddenSurfaces: string[];
  maxDiffLines: number;
  budgetK: number;
}

export interface SynthesizedSpec {
  specId: string; // e.g. 'SPEC-PRD-0011-P1'
  prdId: string;
  phase: number;
  summary: string;
  context: string;
  tasks: SpecTask[];
  envelope: Envelope;
  markdown: string;
  /**
   * Non-fatal synthesis findings for the human reviewing the Draft — e.g.
   * the diff-forecast heuristic flagging task-note paths outside the
   * envelope (#35). Never blocks the write; surfaced by the handler.
   */
  warnings: string[];
}

// SPEC-PRD-0011-P2 contracts
export type SpecStatus = 'Draft' | 'Approved' | 'Done' | 'Superseded';

/** A full implementation spec parsed back from its ADR-0008 Markdown. */
export interface SpecDocument {
  id: string; // e.g. 'SPEC-PRD-0011-P2'
  prdId: string;
  phase: number;
  status: SpecStatus;
  envelope: Envelope;
  tasks: SpecTask[];
  /**
   * SPEC-BUG-retro-and-queued-plans-P1 T-01: prose from the spec's
   * "## Context" section, when the source Markdown has one. It is the raw
   * material for the post-merge retro inference call on `BUG-*` runs.
   * Optional so older callers and hand-built fixtures need no change.
   */
  context?: string;
}

export type TaskRunStatus = 'completed' | 'failed' | 'blocked';

export interface TaskRunResult {
  taskId: string;
  status: TaskRunStatus;
  branch?: string;
  worktreePath?: string;
  detail?: string;
  /** Implementation-step digest the attempt ran against (T-09). */
  inputsDigest?: string;
  /**
   * Merge commit SHA of this task's branch. P3 T-01 dependency semantics:
   * a task is eligible only when every dependsOn task is *merged*, not
   * merely implemented. Set by auto-merge (P3 T-04) or `record-merge --task`.
   */
  mergedSha?: string;
  /** URL of the task's PR (P3 T-02, PRD-0011 §4 TaskResult.prUrl). */
  prUrl?: string;
  recordedAt: string; // ISO timestamp
}

export type GateOutcome = 'pass' | 'breach' | 'blocked' | 'human-required';

/**
 * A machine-gate verdict. Phase 2 runs every gate in shadow mode: the
 * verdict is computed and persisted (with `wouldEscalate` when it would
 * have blocked) but never enforced — human approval is the only advance
 * mechanism.
 */
export interface GateVerdict {
  gate: string; // e.g. 'envelope', 'reviewer', 'phase', 'intake'
  /** Task this verdict was recorded for; absent for run-level verdicts. */
  taskId?: string;
  outcome: GateOutcome;
  wouldEscalate: boolean;
  reasons: string[];
  /** Full agent transcript for agent-driven gates (T-05). */
  transcript?: string;
  /**
   * SHA-256 of the gate's inputs (T-08/T-09): lets gate policy learn from
   * track record and lets resume detect unchanged inputs.
   */
  inputsDigest?: string;
  /** Evidence artifact IDs backing this verdict (T-04/T-08). */
  evidenceIds?: string[];
  /** Per-item findings against `.sdlc/review-checklist.md` (T-01), when present. */
  checklistFindings?: ChecklistFinding[];
  recordedAt: string; // ISO timestamp
}

/**
 * One item of the repo-owned `.sdlc/review-checklist.md` contract
 * (SPEC-BUG-reviewer-house-bar-P1 T-01). `mandatory` items are a hard bar:
 * a failed mandatory item overrides an otherwise-concurring verdict.
 */
export interface ReviewChecklistItem {
  text: string;
  mandatory: boolean;
}

/** The parsed `.sdlc/review-checklist.md` contract. Never empty when present. */
export interface ReviewChecklist {
  items: ReviewChecklistItem[];
}

/**
 * The reviewer's per-item verdict against one `ReviewChecklistItem`.
 * `itemIndex` (1-based, matching prompt order) is the join key back to
 * `ReviewChecklist.items` — more stable than matching echoed text.
 */
export interface ChecklistFinding {
  itemIndex: number;
  item: string;
  outcome: 'pass' | 'fail';
  rationale?: string;
}

/** Reviewer-agent output contract (SPEC-PRD-0011-P2 T-05). */
export interface ReviewerAssessment {
  decision: 'concur' | 'disagree';
  reasons: string[];
  /** Present only when the prompt included a repo checklist (T-01). */
  checklistFindings?: ChecklistFinding[];
}

export type ExceptionTrigger =
  | 'reviewer-disagreement'
  | 'ci-fix-attempts-exhausted'
  | 'envelope-breach'
  | 'budget-exhaustion'
  /** P3 T-04: a red phase gate blocked an enforced merge. */
  | 'merge-blocked'
  /**
   * Wave 0: a *declared* sandbox failed to deploy or report healthy. A repo
   * with no sandbox contract never raises this — see the aggregator.
   */
  | 'sandbox-failed';

/**
 * An exception-ledger entry (SPEC-PRD-0011-P2 T-06): a would-escalate
 * trigger recorded with enough context for later human triage. Shadow mode
 * records; enforcement escalates (Phase 3).
 */
export interface ExceptionEntry {
  trigger: ExceptionTrigger;
  taskId?: string;
  context: string[];
  recordedAt: string; // ISO timestamp
}

/**
 * The repo-owned sandbox contract (SPEC-PRD-0011-P2 T-03): the `sandbox`
 * entry of `.sdlc/environments.json`. The engine never owns deployment
 * mechanics — the repo declares what "deploy" and "healthy" mean (for a
 * CDK app that might be a branch push plus a workflow watch; for a CLI
 * repo, a build). Commands receive the deployed SHA as
 * `SDLC_SANDBOX_SHA`; the health command's output must echo that SHA.
 */
export interface SandboxContract {
  deployCommand: string;
  healthCommand: string;
  timeoutMinutes: number;
}

/** The repo-owned verification contract: `.sdlc/verification.json`. */
export interface VerificationContract {
  testCommand: string;
}

export interface SandboxRecord {
  sha: string;
  status: 'healthy' | 'failed';
  recordedAt: string; // ISO timestamp
  /**
   * Tree-content SHA of `sha` (SPEC-PRD-0022-P1 T-01). Recorded alongside the
   * commit so dedup can ask "is this *content* live?" — a merge commit and the
   * PR head it merged have different commit SHAs and the same tree.
   */
  contentSha?: string;
}

/**
 * What caused a sandbox deploy to be dispatched (SPEC-PRD-0022-P1 T-01).
 *
 * `push` covers deploys the engine did not dispatch itself — a CI workflow
 * reacting to the push — which is exactly the trigger phase-boundary dispatch
 * has to avoid racing.
 */
export type DeployTrigger = 'task' | 'merge' | 'phase-boundary' | 'push';

/** One event in the deploy ledger: a dispatch, its outcome, or a skip. */
export interface DeployRecord {
  /** `git rev-parse <commit>^{tree}` — the dedup key. */
  contentSha: string;
  commitSha: string;
  trigger: DeployTrigger;
  taskId?: string;
  status: 'in-flight' | 'healthy' | 'failed' | 'reused';
  /** Commit SHA whose deploy this reuses. Set only when `status` is `reused`. */
  reusedFrom?: string;
  /** Workflow run URL parsed from deploy output, when the script prints one. */
  workflowRef?: string;
  recordedAt: string;
}

export type CriterionTier = 'test' | 'agent' | 'manual' | 'docs';

export type CriterionOutcome = 'pass' | 'fail' | 'human-required';

/**
 * Per-criterion verification verdict (SPEC-PRD-0011-P2 T-04). Evidence is
 * first-class: `evidenceId` names the artifact (test output, verifier
 * transcript) persisted under the run directory so T-08 can commit it to
 * the Chronicle.
 */
export interface CriterionVerdict {
  taskId: string;
  criterion: string;
  tier: CriterionTier;
  outcome: CriterionOutcome;
  evidenceId?: string;
  recordedAt: string; // ISO timestamp
}

/**
 * How well one acceptance criterion is covered by the run's recorded
 * verdicts (SPEC-PRD-0023-P1 T-01). `no-verdict` is a first-class value, not
 * an absence: closeout derives checkbox state for *every* criterion, so a
 * criterion the run never judged has to be distinguishable from one it
 * judged and failed, and omitting it would silently read as "unchanged".
 */
export type CriterionCoverage = CriterionOutcome | 'no-verdict';

/** One acceptance criterion joined to whatever verdict the run recorded for it. */
export interface CloseoutCriterion {
  /** `<taskId>#<index>` — criteria have no IDs of their own in ADR-0008. */
  criterionId: string;
  taskId: string;
  /** The gate that judges criteria. Always `verification` today. */
  gate: string;
  /** 1-based position within the task's acceptance criteria. */
  index: number;
  /** Raw criterion text, tier prefix included. */
  criterion: string;
  tier: CriterionTier;
  coverage: CriterionCoverage;
  /** Resolvable evidence link, when the verdict carried evidence. */
  evidenceLink?: string;
}

/** One (task, gate) verdict, flattened with its evidence links resolved. */
export interface CloseoutTaskGate {
  taskId: string;
  gate: string;
  outcome: GateOutcome;
  evidenceLinks: string[];
  recordedAt: string;
}

/**
 * The read-only closeout view of a run (SPEC-PRD-0023-P1 T-01): every
 * criterion with its coverage, every (task, gate) verdict, and whether the
 * evidence is complete enough to write `status: Done`.
 *
 * @remarks
 * `fullyCovered` is the *only* input to the spec status roll-up (T-03), and
 * it is deliberately strict: a criterion the run never judged, a task with no
 * green phase gate, or an unmerged task all keep it false. Partial coverage
 * never downgrades a spec — it just leaves the remainder visible.
 */
export interface CloseoutAggregate {
  runId: string;
  specId: string;
  criteria: CloseoutCriterion[];
  taskGates: CloseoutTaskGate[];
  /** Every task the spec declares, in spec order. */
  taskIds: string[];
  /** Task IDs carrying a merge commit on the default branch. */
  mergedTaskIds: string[];
  /** Task IDs whose latest `phase` gate verdict passed. */
  phasePassedTaskIds: string[];
  fullyCovered: boolean;
}

/**
 * One completed step in the T-09 resumable step graph. The key it is stored
 * under is `<name>:<taskId>:<inputsDigest>` — a step re-executes only when
 * its inputs change or it never completed. Kill-resume at any boundary is
 * safe because completion is recorded after the side effect.
 */
export interface StepResult {
  name: string; // e.g. 'implementation', 'envelope', 'digest-post'
  taskId: string;
  inputsDigest: string;
  /** Cached gate verdict for gate steps, reused verbatim on resume. */
  verdict?: GateVerdict;
  /** Small step-specific payload (e.g. sandbox health report). */
  detail?: string;
  /**
   * SPEC-PRD-0021-P1 T-03/T-04: attempt trail when the step needed retries.
   * Absent on a first-attempt success, so its presence is itself the signal
   * that a step was flaky — the record survives on the completed step rather
   * than only in whichever log the operator still had open.
   */
  recovery?: RecoveryHistory;
  completedAt: string; // ISO timestamp
}

export const stepKey = (name: string, taskId: string, digest: string): string =>
  `${name}:${taskId}:${digest}`;

export interface RunState {
  runId: string;
  specId: string;
  specPath: string;
  baseSha: string;
  /**
   * ISO timestamp when the run was first launched — written before intake
   * completes so a crash never leaves `status` answering RUN_NOT_FOUND (#37).
   */
  startedAt?: string;
  /** Digest of the spec document captured at launch / after intake. */
  specDigest?: string;
  /** Process argv captured at launch for forensics. */
  launchArgv?: string[];
  taskResults: Record<string, TaskRunResult>;
  verdicts: GateVerdict[];
  exceptions: ExceptionEntry[];
  criterionVerdicts: CriterionVerdict[];
  /** T-09 step graph: cached step results keyed by name:taskId:inputsDigest. */
  steps: Record<string, StepResult>;
  sandbox?: SandboxRecord;
  /** Merged SHA recorded when a human approves the merge (T-08). */
  mergedSha?: string;
  /** Cumulative model-token spend in thousands, metered where available. */
  tokenSpendK: number;
  /** Per-task count of failing CI fix attempts (Phase-3 machinery records). */
  ciFixAttempts: Record<string, number>;
  /**
   * Wave 0: per-task count of gate remediation rounds (reviewer / envelope
   * re-dispatch). Persisted so a resume cannot refill the attempt budget.
   */
  gateFixAttempts: Record<string, number>;
  /**
   * Wave 0: the latest engine remediation per task. Task re-selection uses
   * it to reopen a task whose phase gate breached *before* a fix landed —
   * without it, the breach would stay terminal and the fix would never be
   * judged.
   */
  remediations: Record<string, RemediationRecord>;
  /**
   * Wave 0: count of supervisor merge-blocked retries for this run.
   * Persisted so a relaunch cannot loop forever on the same block.
   */
  mergeBlockedRetries: number;
  updatedAt: string; // ISO timestamp
}

/**
 * One attempt inside a {@link RecoveryHistory} (SPEC-PRD-0021-P1 T-03).
 *
 * `action` names what the engine did, not what went wrong: `attempt`,
 * `backoff`, `escalate`. Together with `outcome` this is the durable answer
 * to "why did this take four minutes and six tries", which previously
 * existed only in whichever log the operator still had open.
 */
export interface RecoveryAttempt {
  attempt: number;
  action: 'attempt' | 'backoff' | 'escalate';
  outcome: 'succeeded' | 'failed' | 'exhausted' | 'waited';
  /** Failure message for a failed attempt; backoff duration for a wait. */
  detail?: string;
  at: string; // ISO timestamp
}

/**
 * The recovery record a retried step returns (SPEC-PRD-0021-P1 T-03).
 * `escalated` is true only once the attempt cap was reached.
 */
export interface RecoveryHistory {
  /** Recovery path label, e.g. `pr:T-01` — one budget per path. */
  path: string;
  attempts: RecoveryAttempt[];
  escalated: boolean;
}

/** Wave 0: one engine-driven gate remediation round for a task. */
export interface RemediationRecord {
  attempt: number;
  /** Head SHA the remediation produced — the ref the gates must re-judge. */
  sha: string;
  /** Gate names the round was asked to address. */
  gates: string[];
  recordedAt: string; // ISO timestamp
}

// --- T-08 Chronicle artifact schemas (versioned from day one) ---

export type ArtifactSchema =
  | 'sdlc.spec.v1'
  | 'sdlc.task-result.v1'
  | 'sdlc.verdict.v1'
  | 'sdlc.exceptions.v1'
  | 'sdlc.digest.v1'
  | 'sdlc.merge.v1'
  | 'sdlc.revert.v1'
  | 'sdlc.outcome.v1'
  | 'sdlc.retro.v1';

export interface ChronicleArtifact {
  schema: ArtifactSchema;
  runId: string;
  specId: string;
  recordedAt: string; // ISO timestamp
  payload: unknown;
}

/** Payload of an `sdlc.verdict.v1` artifact — the gate-policy contract. */
export interface VerdictArtifactPayload {
  gate: string;
  inputsDigest: string;
  outcome: GateOutcome;
  wouldEscalate: boolean;
  reasons: string[];
  evidenceRefs: string[]; // resolvable evidence artifact IDs
  taskId: string;
}

/**
 * BUG-reviewer-house-bar-P1 T-02: what eventually happened to a recorded gate
 * verdict, so per-gate precision (how often a concur preceded a veto/rework,
 * how often a breach was overridden) is computable from the ledger.
 * `reworked` is reserved for a future rework-detection trigger; this task
 * wires only `vetoed` (queue-veto revert) and `stood` (human-approved merge).
 */
export type VerdictOutcome = 'vetoed' | 'reworked' | 'stood';

/**
 * Payload of an `sdlc.outcome.v1` artifact — links one gate verdict (by
 * task + gate + its inputs digest) to its eventual outcome. One artifact
 * per (runId, taskId, gate); re-recording the same outcome overwrites the
 * same file rather than appending a duplicate.
 */
export interface OutcomeArtifactPayload {
  taskId: string;
  gate: string;
  verdictInputsDigest: string;
  outcome: VerdictOutcome;
}

export interface DiffStat {
  files: Array<{ path: string; lines: number }>;
  totalLines: number;
}

/**
 * PRD-0020 §4 — consumer-owned daemon configuration. Values come from files
 * under the workspace root; the engine never compiles in org/repo/path
 * opinions. Runtime paths (pid, log, launchd label) are derived from
 * `workspaceRoot` by the config loader.
 */
export interface DaemonConfig {
  workspaceRoot: string;
  activateScript: string;
  runsDir: string;
  defaultPollSeconds: number;
  headlessRunner: string;
}

/** Process-local paths and launchd identity derived for one workspace root. */
export interface DaemonRuntimePaths {
  stateDir: string;
  pidFile: string;
  logPath: string;
  launchdLabel: string;
}

export type WatchKind =
  | 'pr-review'
  | 'pr-checks'
  | 'issue-state'
  | 'workflow-run'
  | 'run-supervisor'
  | 'queue-item';

export interface WatchTarget {
  repo?: string;
  number?: number;
  runId?: string;
}

export interface HeadlessAction {
  kind: 'agent-dispatch' | 'engine-command';
  prompt?: string;
  argv?: string[];
  transcriptDir: string;
}

/** PRD-0020 §4 durable watch registration contract. */
export interface WatchRegistration {
  /** Stable identity derived from `kind + target`. */
  id: string;
  kind: WatchKind;
  target: WatchTarget;
  pollSeconds: number;
  action?: HeadlessAction;
  createdBy: string;
  expiresAt?: string;
}

/** Input accepted by the registry; identity and lifecycle fields are derived. */
export type WatchRegistrationInput = Omit<WatchRegistration, 'id'>;

/** File-backed registration plus registry-owned lifecycle metadata. */
export interface DurableWatchRecord extends WatchRegistration {
  createdAt: string;
  lastPollTime?: string;
  expiredAt?: string;
  terminalState?: string;
}

/** Active-watch projection consumed by status surfaces. */
export interface ActiveWatch extends WatchRegistration {
  /** Whole seconds since registration. */
  age: number;
  lastPollTime: string | null;
}

/** Input whose identity is the `(kind, target, signal)` tuple. */
export interface WakeEventInput {
  kind: string;
  target: string;
  signal: string;
  createdAt: string;
  prompt?: string;
  data?: Record<string, unknown>;
}

/** Durable wake payload with its deterministic idempotency key. */
export interface WakeEvent extends WakeEventInput {
  id: string;
}

export type WorkflowErrorCode =
  | 'PRD_NOT_FOUND'
  | 'PRD_MALFORMED'
  | 'DECOMPOSE_EMPTY'
  | 'INFERENCE_FAILED'
  | 'INFERENCE_INVALID'
  | 'SPEC_INVALID'
  | 'ENVELOPE_UNGROUNDED'
  | 'SPEC_EXISTS'
  | 'SURFACE_UNRESOLVABLE'
  | 'MISSING_API_KEY'
  | 'INVALID_BACKEND'
  | 'SPEC_MALFORMED'
  | 'CONTRACT_MALFORMED'
  | 'RUN_NOT_FOUND'
  /** SPEC-PRD-0021-P1 T-02: another live writer already owns the run. */
  | 'RUN_LOCK_HELD'
  /** T-02: a state.json write was refused because the run is foreign-locked. */
  | 'RUN_LOCK_NOT_HELD'
  | 'GIT_FAILED'
  | 'GH_FAILED'
  /** SPEC-PRD-0020-P1 T-01: workspace root missing or daemon config unusable. */
  | 'DAEMON_CONFIG_INVALID';

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: WorkflowErrorCode,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
