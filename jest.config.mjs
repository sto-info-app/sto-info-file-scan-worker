export default {
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: String.raw`.*\.spec\.ts$`,
  transform: {
    [String.raw`^.+\.(t|j)s$`]: ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverage: true,
  coverageReporters: ['text-summary', 'text', 'lcov', 'cobertura'],
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!**/*.spec.(t|j)s',
    '!**/*.module.(t|j)s',
    '!**/main.(t|j)s',
    '!**/*.d.ts',
    '!**/*.dto.(t|j)s',
    '!**/*.entity.(t|j)s',
    '!**/*.entities.(t|j)s',
    '!**/*.interface.(t|j)s',
    '!**/*.interfaces.(t|j)s',
    '!**/*.enum.(t|j)s',
    '!**/*.constant.(t|j)s',
    '!**/*.constants.(t|j)s',
    '!**/database/migrations/**',
    '!**/index.ts',
    '!**/reports/**',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/reports/',
    '/config/environments/',
    '/database/migrations/',
    '/src/main.ts',
  ],
  testEnvironment: 'node',
  // Raised from zero. The worker enforced nothing and had one spec file
  // covering one utility, while the backend has enforced 100% throughout.
  // Two standards in one project means the weaker one decides, and an
  // untested credential or object-store path is exactly where a mistake
  // hides.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  coverageDirectory: '<rootDir>/reports/coverage',
};
