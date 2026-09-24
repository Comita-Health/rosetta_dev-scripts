import { Envelope, ReviewChecklist, SpecTask } from '../types';

/** Checklist section appended when the repo declares one (T-01). */
const buildChecklistSection = (checklist: ReviewChecklist): string[] => [
  '',
  '## Repo review checklist',
  '',
  'The target repo declares the checklist below (`.sdlc/review-checklist.md`).',
  'Evaluate the diff against every item and return one finding per item, in',
  'order, in `checklistFindings` — each finding names its `itemIndex`',
  '(matching the numbering below), echoes the `item` text, and gives an',
  '`outcome` of "pass" or "fail" (with a `rationale` on fail). Items marked',
  '(mandatory) are a hard bar: a failed mandatory item means the diff does',
  'not pass review even if nothing else is wrong — set `decision` to',
  '"disagree" in that case.',
  '',
  ...checklist.items.map(
    (item, i) => `${i + 1}. ${item.text}${item.mandatory ? ' (mandatory)' : ''}`
  )
];

/**
 * Build the reviewer-agent prompt (SPEC-PRD-0011-P2 T-05). Independence is
 * structural: built from exactly the diff, the spec task, the envelope,
 * and (when declared) the repo's review checklist — never from
 * implementation-agent conversation state.
 *
 * Includes the workspace documentation bar (TSDoc/JSDoc) and the
 * architecture bar (substitutability). `checklist` omitted (undefined)
 * reproduces the pre-checklist prompt byte-for-byte
 * (SPEC-BUG-reviewer-house-bar-P1 T-01 no-regression requirement).
 *
 * @remarks
 * This prompt is the upstream default, so it stays domain-neutral: a consumer's
 * rules ("never log a payment-card number") arrive through
 * `.sdlc/review-checklist.md`, which is the seam ADR-0009 requires policy to
 * travel through. A domain example baked in here would ship one consumer's
 * vocabulary to every other one.
 */
export const buildReviewerPrompt = (
  task: SpecTask,
  envelope: Envelope,
  diff: string,
  checklist?: ReviewChecklist
): string =>
  [
    'You are an independent code reviewer. You have no context beyond what',
    'is below: one spec task, its blast-radius envelope, and the diff of the',
    'branch that claims to implement it. Decide whether you concur that the',
    'diff correctly and safely implements the task.',
    '',
    `## Task ${task.id}: ${task.title}`,
    '',
    task.engineeringNotes,
    '',
    '### Acceptance criteria',
    '',
    ...task.acceptanceCriteria.map(c => `- ${c}`),
    '',
    '## Blast-radius envelope',
    '',
    `- Allowed paths: ${envelope.allowedPaths.join(', ')}`,
    `- Forbidden surfaces: ${envelope.forbiddenSurfaces.join(', ')}`,
    `- Max diff lines: ${envelope.maxDiffLines} (advisory — test files`,
    '  `*.test.*` / `*.spec.*` / `__tests__/**` / `__mocks__/**` are',
    '  exempt; oversize vs this budget is a digest note, not a halt.',
    '  Do not disagree on size alone.)',
    '',
    'HARD RULE — disagree if the diff touches `specs/**` (or `**/specs/**`),',
    'flips acceptance-criteria checkboxes, or changes `status:`. Mid-run',
    'spec edits are forbidden even when listed in allowedPaths; Done',
    'closeout is a later docs PR.',
    '',
    'HARD RULE — disagree if the diff touches `specs/**` (or `**/specs/**`),',
    'flips acceptance-criteria checkboxes, or changes `status:`. Mid-run',
    'spec edits are forbidden even when listed in allowedPaths; Done',
    'closeout is a later docs PR.',
    '',
    '## Diff',
    '',
    '```diff',
    diff,
    '```',
    '',
    '## Documentation bar (TSDoc / JSDoc)',
    '',
    'Treat useful inline docs as part of correctness for new or substantially',
    'changed exports — same bar as a missing test when the surface warrants it.',
    '',
    '- Backend / engine: new `@injectable()` Handler, Service, or Repository',
    '  classes and their new public methods need TSDoc covering purpose and',
    '  non-obvious invariants (authorization, data-sensitivity boundaries,',
    '  idempotency, ordering, failure modes).',
    '  Do not require `@param` / `@returns` that only restate TypeScript types.',
    '- Frontend: types/props are the primary API docs; require short TSDoc on',
    '  non-obvious platform/auth/session/entitlement helpers. Do not fail solely',
    '  for missing prop JSDoc on presentational components when types are clear.',
    '- Disagree on placeholder noise (`/** Service */`) or missing docs on a new',
    '  HSR class / non-obvious public helper introduced in the diff.',
    '',
    '## Architecture bar (substitutability)',
    '',
    'The Repository layer is an anti-corruption boundary. A vendor,',
    'datastore, or transport swap must be a new Repository plus a changed',
    'binding. If the swap requires editing a Service or Handler, disagree —',
    'the boundary is in the wrong place.',
    '',
    '- No vendor SDK types in exported signatures. A Repository may import',
    '  an SDK; its public contract may not accept or return SDK types.',
    '  Boundary DTOs live in `types.ts`.',
    '- There is no fourth layer. Anything performing I/O is a Repository.',
    '  A `clients/`, `lib/`, or `integrations/` directory holding a vendor',
    '  client is a violation.',
    '- No singletons or static accessors (`getInstance()`, module-level',
    '  mutable instances). Lifetime belongs to the container.',
    '- Bind interfaces, not classes: `container.bind<IFoo>(TOKENS.Foo).to(Foo)`.',
    '  `bind(Foo).toSelf()` and `@inject(ConcreteClass)` fail this bar.',
    '- Config is injected at the composition root. `process.env` inside a',
    '  Service or Repository method is a fail.',
    '- One composition root per entry point. `container.get()` elsewhere is',
    '  a service locator.',
    '- Substitutability is provable in tests: bind a fake adapter to the',
    '  same token. If a Service test must `jest.mock` a vendor SDK to',
    '  isolate the Service, the port is missing.',
    '- Disagree on a new or changed export that leaks a vendor type, adds a',
    '  static accessor, or binds a concrete class where an interface token',
    '  is required.',
    '',
    'Return your verdict: "concur" only if the diff implements the task',
    'within the envelope with no correctness, safety, documentation-bar,',
    'or architecture-bar concerns; otherwise "disagree" with every concern',
    'cited as a reason.',
    ...(checklist ? buildChecklistSection(checklist) : [])
  ].join('\n');
