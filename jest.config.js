module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/src/**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // Make untested files visible under --coverage instead of silently omitting any
  // file no test imports. Type-only modules and the thin DOM-bootstrap entrypoints
  // (exercised by the Playwright E2E suite, not unit tests) are excluded so the
  // report reflects unit-testable logic.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/shared/types/**',
    '!src/shared/recordingTypes.ts',
    '!src/shared/settings/model.ts',
    '!src/shared/provider.ts',
    '!src/content/MeetingProviderAdapter.ts',
    '!src/popup.ts',
    '!src/debug.ts',
    '!src/camsetup.ts',
    '!src/micsetup.ts'
  ]
};
