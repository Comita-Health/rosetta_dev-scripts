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
  outcome: GateOutcome;
  wouldEscalate: boolean;
  reasons: string[];
  /** Full agent transcript for agent-driven gates (T-05). */
  transcript?: string;
  recordedAt: string; // ISO timestamp
}

/** Reviewer-agent output contract (SPEC-PRD-0011-P2 T-05). */
export interface ReviewerAssessment {
  decision: 'concur' | 'disagree';
  reasons: string[];
}

export type ExceptionTrigger =
  | 'reviewer-disagreement'
  | 'ci-fix-attempts-exhausted'
  | 'envelope-breach'
  | 'budget-exhaustion';

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

export interface RunState {
  runId: string;
  specId: string;
  specPath: string;
  baseSha: string;
  taskResults: Record<string, TaskRunResult>;
  verdicts: GateVerdict[];
  exceptions: ExceptionEntry[];
  criterionVerdicts: CriterionVerdict[];
  sandbox?: SandboxRecord;
  /** Cumulative model-token spend in thousands, metered where available. */
  tokenSpendK: number;
  /** Per-task count of failing CI fix attempts (Phase-3 machinery records). */
  ciFixAttempts: Record<string, number>;
  updatedAt: string; // ISO timestamp
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
  | 'SPEC_EXISTS'
  | 'MISSING_API_KEY'
  | 'INVALID_BACKEND'
  | 'SPEC_MALFORMED'
  | 'CONTRACT_MALFORMED'
  | 'GIT_FAILED';

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
