export const WORKFLOW_TOKENS = {
  ModelRepository: Symbol.for('ModelRepository'),
  InferenceRepository: Symbol.for('InferenceRepository'),
  PrdRepository: Symbol.for('PrdRepository'),
  SpecFileRepository: Symbol.for('SpecFileRepository'),
  DecomposeService: Symbol.for('DecomposeService'),
  SpecSynthesisService: Symbol.for('SpecSynthesisService'),
  WorkflowHandler: Symbol.for('WorkflowHandler'),
  // SPEC-PRD-0011-P2
  SpecDocRepository: Symbol.for('SpecDocRepository'),
  GitRepository: Symbol.for('GitRepository'),
  AgentRunnerRepository: Symbol.for('AgentRunnerRepository'),
  RunStateRepository: Symbol.for('RunStateRepository'),
  RunLockRepository: Symbol.for('RunLockRepository'),
  SurfaceMapRepository: Symbol.for('SurfaceMapRepository'),
  ReviewChecklistRepository: Symbol.for('ReviewChecklistRepository'),
  ContractRepository: Symbol.for('ContractRepository'),
  ShellCommandRepository: Symbol.for('ShellCommandRepository'),
  EvidenceRepository: Symbol.for('EvidenceRepository'),
  QueueRepository: Symbol.for('QueueRepository'),
  ChronicleArtifactRepository: Symbol.for('ChronicleArtifactRepository'),
  CiStatusRepository: Symbol.for('CiStatusRepository'),
  ExecutorService: Symbol.for('ExecutorService'),
  EnvelopeGateService: Symbol.for('EnvelopeGateService'),
  SandboxDeployService: Symbol.for('SandboxDeployService'),
  VerificationService: Symbol.for('VerificationService'),
  ReviewerGateService: Symbol.for('ReviewerGateService'),
  ReviewerPublishService: Symbol.for('ReviewerPublishService'),
  AggregatorService: Symbol.for('AggregatorService'),
  CiGateService: Symbol.for('CiGateService'),
  DigestService: Symbol.for('DigestService'),
  RetroService: Symbol.for('RetroService'),
  ChronicleCommitService: Symbol.for('ChronicleCommitService'),
  GatePolicyQueryService: Symbol.for('GatePolicyQueryService'),
  RunHandler: Symbol.for('RunHandler'),
  // SPEC-PRD-0011-P3
  PullRequestRepository: Symbol.for('PullRequestRepository'),
  IssueRepository: Symbol.for('IssueRepository'),
  WakeInboxRepository: Symbol.for('WakeInboxRepository'),
  PrLifecycleService: Symbol.for('PrLifecycleService'),
  EscalationService: Symbol.for('EscalationService'),
  GateRemediationService: Symbol.for('GateRemediationService'),
  RetryExecutorService: Symbol.for('RetryExecutorService'),
  HeartbeatService: Symbol.for('HeartbeatService'),
  HeartbeatWatchService: Symbol.for('HeartbeatWatchService'),
  ProcessDetachRepository: Symbol.for('ProcessDetachRepository'),
  SuperviseExitRepository: Symbol.for('SuperviseExitRepository'),
  SuperviseService: Symbol.for('SuperviseService'),
  // SPEC-BUG-retro-and-queued-plans T-02
  RunQueueRepository: Symbol.for('RunQueueRepository'),
  // SPEC-PRD-0022-P1 T-01
  DeployRecordRepository: Symbol.for('DeployRecordRepository'),
  // SPEC-PRD-0022-P1 T-03 — observe push-triggered Actions deploys
  DeployObservationRepository: Symbol.for('DeployObservationRepository'),
  // SPEC-PRD-0023-P1 T-01 / T-02
  CloseoutAggregateService: Symbol.for('CloseoutAggregateService'),
  CloseoutService: Symbol.for('CloseoutService'),
  // SPEC-PRD-0020-P1 T-01
  DaemonConfigRepository: Symbol.for('DaemonConfigRepository'),
  DaemonProcessRepository: Symbol.for('DaemonProcessRepository'),
  LaunchdRepository: Symbol.for('LaunchdRepository'),
  DaemonLifecycleService: Symbol.for('DaemonLifecycleService'),
  DaemonHandler: Symbol.for('DaemonHandler'),
  // SPEC-PRD-0020-P1 T-02
  DaemonStoreRepository: Symbol.for('DaemonStoreRepository'),
  // SPEC-PRD-0020-P1 T-03
  WatchRegistryService: Symbol.for('WatchRegistryService'),
  // SPEC-PRD-0020-P1 T-04
  WatchSourceAdapterRegistry: Symbol.for('WatchSourceAdapterRegistry'),
  PollSchedulerService: Symbol.for('PollSchedulerService'),
  // SPEC-PRD-0020-P1 T-05
  GitHubWatchSourceRepository: Symbol.for('GitHubWatchSourceRepository'),
  PrReviewWatchSourceAdapter: Symbol.for('PrReviewWatchSourceAdapter'),
  PrChecksWatchSourceAdapter: Symbol.for('PrChecksWatchSourceAdapter'),
  // PRD-0020 remote-resume slice (blocker-close / PR-merge → relaunch)
  IssueStateWatchSourceAdapter: Symbol.for('IssueStateWatchSourceAdapter'),
  EngineResumeWakeAction: Symbol.for('EngineResumeWakeAction'),
  // SPEC-PRD-0020-P1 T-06
  WakeActionRegistry: Symbol.for('WakeActionRegistry'),
  WakeConsumptionService: Symbol.for('WakeConsumptionService'),
  // SPEC-PRD-0020-P1 T-07
  KnownWatchTargetRepository: Symbol.for('KnownWatchTargetRepository'),
  DaemonStatusService: Symbol.for('DaemonStatusService'),
  // Operator cutover: ~/.rosetta/wake → .sdlc/daemon/wake
  LegacyWakeInboxRepository: Symbol.for('LegacyWakeInboxRepository'),
  LegacyWakeMigrateService: Symbol.for('LegacyWakeMigrateService')
} as const;
