const base = require('../jest.config.base.json');

module.exports = {
  ...base,
  // @swc/jest transpiles only (no per-file type-check); type-checking is the
  // build's job (`tsc`, TypeScript 7 native). Decorator metadata is required
  // for InversifyJS constructor injection.
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022'
        },
        module: { type: 'commonjs' }
      }
    ]
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    }
  }
};
