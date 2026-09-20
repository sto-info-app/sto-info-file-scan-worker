/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'jest',
  // Jest retains full AggregatedResult data (titles, assertion messages,
  // mock call data) for every test it has ever run, for the lifetime of the
  // process, so a test runner worker's heap only ever grows. The flag is
  // also how the runner gets --experimental-vm-modules, which this project's
  // own test scripts set and which ts-jest needs here for the same reason.
  //
  // These values are the backend's, arrived at there by measurement. This
  // repository's mutate set is far smaller and will not come close to the
  // ceiling, but a ceiling is not a reservation, and sharing the number
  // means a mutation run that works in one repository works in the other.
  testRunnerNodeArgs: [
    '--experimental-vm-modules',
    '--max-old-space-size=8192',
  ],
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.mjs',
    enableFindRelatedTests: true,
  },
  mutate: [
    'src/**/*.ts',

    // Exclude tests
    '!src/**/*.spec.ts',

    // Keep these aligned with jest.config.mjs collectCoverageFrom excludes
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/*.d.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.entity.ts',
    '!src/**/*.entities.ts',
    '!src/**/*.interface.ts',
    '!src/**/*.interfaces.ts',
    '!src/**/*.enum.ts',
    '!src/**/*.constant.ts',
    '!src/**/*.constants.ts',
    '!src/database/migrations/**',
    '!src/**/index.ts',
  ],
  checkers: ['typescript'],
  coverageAnalysis: 'perTest',
  // With a checker configured Stryker splits this budget: ceil(n / 2)
  // checker processes and floor(n / 2) test runners, handing the checker
  // tokens back as extra test runners once type checking finishes. At the
  // previous value of 2 that meant a single test runner for the whole
  // checking phase, leaving half of a 4-vCPU runner idle. 4 matches the
  // vCPU count of a GitHub-hosted ubuntu-latest runner.
  concurrency: 4,
  // Static mutants force a full reload + full test run per mutant. Stryker
  // measured these at 1% of mutants but 72% of run time on the backend.
  ignoreStatic: true,
  // Recycle the worker before the heap growth described in testRunnerNodeArgs
  // above can reach the ceiling. 8 keeps the peak near 1.5GB.
  maxTestRunnerReuse: 8,
  // Stryker allows a mutant timeoutMS + timeoutFactor * netTime before calling
  // it timed out, and the 5000ms default is not enough to boot a Nest testing
  // module. Because Stryker scores a timeout as a kill, too low a value lets a
  // file report a perfect score off zero actual kills.
  timeoutMS: 30000,
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },
  ignorePatterns: ['dist', 'node_modules', 'coverage'],
  tempDirName: '.stryker-tmp',
  tsconfigFile: 'tsconfig.spec.json',
};
