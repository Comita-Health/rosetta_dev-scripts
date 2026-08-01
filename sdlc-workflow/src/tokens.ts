export const WORKFLOW_TOKENS = {
  ModelRepository: Symbol.for('ModelRepository'),
  InferenceRepository: Symbol.for('InferenceRepository'),
  PrdRepository: Symbol.for('PrdRepository'),
  SpecFileRepository: Symbol.for('SpecFileRepository'),
  DecomposeService: Symbol.for('DecomposeService'),
  SpecSynthesisService: Symbol.for('SpecSynthesisService'),
  WorkflowHandler: Symbol.for('WorkflowHandler')
} as const;
