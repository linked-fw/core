/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/tests'],
  testMatch: ['<rootDir>/src/tests/*.test.ts'],
  globalSetup: '<rootDir>/src/tests/global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/global-teardown.ts',
  // Adds a `[fuseki] live tests: …` count to every run's output.
  reporters: ['default', '<rootDir>/src/tests/fuseki-live-reporter.cjs'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  // Strip the `.js` extension from relative ESM imports so ts-jest resolves the
  // `.ts` source (NodeNext-style specifiers carry `.js`; jest maps back to src).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
