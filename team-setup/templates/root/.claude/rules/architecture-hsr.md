# Architecture — Handler / Service / Repository + InversifyJS

**This pattern is mandatory for all TypeScript code in every Rosetta repo.** Treat a violation the same as a failing test.

## The three layers

Dependency direction is strictly one-way: **Handler → Service → Repository**.

- A **Handler** is the entry point. It parses the incoming event/request/args, dispatches to a
  Service, and returns the response. It contains **no business logic**.
- A **Service** holds business and orchestration logic: validation, authorization, aggregation, and
  composition of one or more Repository calls. Services may depend on Repositories.
- A **Repository** does resource access only: SDK calls, database reads/writes, HTTP/API calls,
  filesystem reads. It contains **no business logic**.

Hard rules on direction:

- Repositories never call Services.
- Services never call other Services. Compose at the Handler, or introduce a coordinating Service
  that depends only on Repositories.
- A Repository may depend on a lower-level Repository (e.g. a domain repo wrapping a raw SDK repo).

## Dependency injection with InversifyJS

- Every Handler, Service, and Repository class is decorated with `@injectable()`.
- Dependencies are injected through the constructor with `@inject(TOKEN)`.
- Injected fields are `private readonly` and **prefixed with an underscore**
  (e.g. `private readonly _usageRepo: IUsageRepository`).
- Consumers type an injected dependency as its **interface**, never the concrete class.

## Tokens

- Injection tokens are `Symbol.for('Name')` values collected in a single `*_TOKENS` const object
  per DI domain, e.g. `CHRONICLE_TOKENS = { ChronicleService: Symbol.for('ChronicleService'), ... } as const`.
- Use `Symbol.for` (the global registry), **not** `Symbol()`. This guarantees the same symbol is
  returned across module instances — which matters when the container and the class under test load
  from different module instances under Jest.
- The **token** (not the interface) is the runtime injection key. The interface only type-checks the
  binding: `container.bind<IFoo>(TOKENS.Foo).to(Foo)`.

## Interfaces & contracts

- Each layer file exports **both** the interface and its implementing class, co-located:

  ```ts
  export interface IChronicleService {
    generateDailyChronicle(input: DailyChronicleInput): Promise<DailyChronicle>;
  }

  @injectable()
  export class ChronicleService implements IChronicleService {
    constructor(
      @inject(CHRONICLE_TOKENS.GitRepository)
      private readonly _gitRepo: IGitRepository
    ) {}
    // ...
  }
  ```

- Interfaces are **`I`-prefixed** (`IChronicleService`, `IGitRepository`).
- **Never use `abstract class`** for contracts — use an interface.

## Composition root

- `index.ts` (or `bin/app.ts` for CDK) is the only place that wires the container. It contains **no
  business logic**:
  1. `import 'reflect-metadata';` as the very first statement.
  2. `const container = new Container();`
  3. `container.bind<IFoo>(TOKENS.Foo).to(Foo);` for every class
     (`.toConstantValue(x)` for pre-built singletons such as a logger).
  4. Resolve the root Handler with `container.get(TOKENS.RootHandler)` and export the bound entry point.

## Where other code goes

- Pure functions live in `src/utils/` — never inline non-trivial pure logic in a handler/service.
- Boundary/DTO/wire types live in `src/types.ts` — never duplicate them as local interfaces.

## Required build config

`tsconfig.json` must set (decorator metadata is required for `@inject` to work):

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    // TypeScript 7: `types` defaults to [] — list globals explicitly.
    "types": ["node", "jest"]
  }
}
```

TypeScript 7 (native compiler) notes: `moduleResolution: "node"` (node10) is
removed — use `"nodenext"` (Node CLIs) or `"bundler"` (Vite apps). Tests
transpile via `@swc/jest` with `legacyDecorator` + `decoratorMetadata`;
type-checking is the build's job (`tsc`).

Dependencies: `inversify@^7`, `reflect-metadata@^0.2`, `typescript@^7`.

## Testing the pattern

- Construct a fresh `new Container()` per test (`beforeEach`), bind `jest.fn()`-based mocks with
  `.toConstantValue(mock)`, bind the real class under test with `.to(Class)`, then
  `container.get(TOKENS.X)`.
- `require()` the class-under-test and tokens **after** any module-level `jest.mock()` calls so the
  mocks apply before the class loads.
- Test class behaviour only — **never** test the container wiring itself.
