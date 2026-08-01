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
  SurfaceMapRepository: Symbol.for('SurfaceMapRepository'),
  ExecutorService: Symbol.for('ExecutorService'),
  EnvelopeGateService: Symbol.for('EnvelopeGateService'),
  RunHandler: Symbol.for('RunHandler')
} as const;
