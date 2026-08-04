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
  | 'merge-blocked';

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
}

export type CriterionTier = 'test' | 'agent' | 'manual';

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
  updatedAt: string; // ISO timestamp
}

// --- T-08 Chronicle artifact schemas (versioned from day one) ---

export type ArtifactSchema =
  | 'sdlc.spec.v1'
  | 'sdlc.task-result.v1'
  | 'sdlc.verdict.v1'
  | 'sdlc.exceptions.v1'
  | 'sdlc.digest.v1'
  | 'sdlc.merge.v1'
  | 'sdlc.revert.v1';

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

export interface DiffStat {
  files: Array<{ path: string; lines: number }>;
  totalLines: number;
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
  | 'GIT_FAILED'
  | 'GH_FAILED';

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
