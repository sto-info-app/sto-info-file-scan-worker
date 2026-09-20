# Quality Automation

This document outlines the automated tools and processes used to maintain high code quality standards.

## Semantic PRs

We enforce the [Conventional Commits](https://www.conventionalcommits.org/) specification for pull request titles.

- **What it enforces**: PR titles must follow a specific format (e.g. `feat: lease an attempt before scanning`, `fix: resolve clamd socket timeout`).
- **Why**: This enables automated versioning, changelog generation, and better commit history readability.
- **How to fix**: If a check fails, update the PR title to follow the pattern `<type>: <description>`. Valid types include `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, and `ci`.

## Linting and formatting

- **Lint**: `npm run lint` runs ESLint over `src`, `apps`, `libs` and `test`, with the same flat config and the same `naming-convention` rules as the backend — so a convention learned in one repository holds in the other.
- **Format**: Prettier owns layout, including import order, via `@ianvs/prettier-plugin-sort-imports`. `npm run format:check` is its own step in the lint-test workflow, so unformatted code fails the build rather than being quietly corrected.
- **Locally**: A `pre-commit` hook runs lint-staged over staged TypeScript, applying `eslint --fix` and `prettier --write` in place. See [CONTRIBUTING.md](../../CONTRIBUTING.md#git-hooks).

## Jest coverage thresholds

Jest enforces coverage thresholds during CI and locally.

- **Threshold**: 100% of statements, branches, functions and lines. The exclusions — modules, entities, DTOs, enums, constants, migrations and the entry point — are listed in [jest.config.mjs](../../jest.config.mjs).
- **Local**: `npm run test:cov` runs tests and enforces the thresholds.
- **CI**: The lint-test workflow runs `test:cov` and then asserts `reports/coverage/lcov.info` exists, so a silently empty coverage run fails rather than passes.
- **ESM packages**: Jest scripts set `NODE_OPTIONS=--experimental-vm-modules`. Run tests through the npm scripts rather than invoking `jest` directly.

If the test suite passes but the job fails, check the per-file coverage output in the Jest summary and the generated report in `reports/coverage/`.

## Mutation testing (Stryker)

Mutation testing validates the effectiveness of the tests: a test suite that
holds 100% coverage but survives a mutation was not really testing that line.
It is what makes the coverage threshold above mean something.

- **Full run**: `npm run test:mutation`, and weekly on a schedule via [mutation-testing.yml](../../.github/workflows/mutation-testing.yml).
- **Incremental (PRs)**: [mutation-testing-incremental.yml](../../.github/workflows/mutation-testing-incremental.yml) mutates only the changed files.
  - `scripts/run-incremental-mutation.mjs` computes the relevant changed files under `src/**/*.ts`, excluding specs, modules and other non-runtime files, and mutates only those.
  - It uses Stryker incremental mode to cache results between runs, and exits 0 when the diff contains nothing mutatable.
  - Reproduce locally with: `BASE_REF=origin/<base-branch> npm run test:mutation:incremental`
- **Sandbox**: Stryker copies the tree into `.stryker-tmp`. A cancelled run can leave that copy behind, which would make a later plain `jest` run discover every spec twice — [jest.config.mjs](../../jest.config.mjs) ignores it by an anchored path to prevent that.

## Codecov

Codecov provides analysis of our test coverage.

- **Uploads**: CI uploads both coverage (`reports/coverage/lcov.info`) and JUnit test results (`reports/junit/junit.xml`).
- **Status**: This repository is **not yet onboarded to Codecov**. The upload steps are in place and set `fail_ci_if_error: false`, so they no-op until a `CODECOV_TOKEN` secret is added and the repository is enabled — at which point coverage reports and PR comments start appearing with no further change here.

## SonarCloud Quality Gate

SonarCloud enforces a "Quality Gate" that must pass for all changes.

- **Metrics**: It checks for bugs, code smells, vulnerabilities, and duplication.
- **Project**: `sto-info-app_sto-info-file-scan-worker`, configured in [sonar-project.properties](../../sonar-project.properties).
- **Feedback**: A passing Quality Gate is required for merging to the `development` branch.

## Required Status Checks & "Smart Skips"

To maintain high standards without making the development process frustrating, we use a "Smart Skip" strategy for our required PR checks.

- **Behavior**: All required workflows (`Lint and Test`, `Audit`, `CodeQL`, etc.) trigger on every PR to `development` and `production` to ensure status checks are never "stuck."
- **Efficiency**: A lightweight filter job identifies if relevant code was changed. If only documentation, READMEs, or configs were updated, the heavy jobs are skipped.
- **Compliance**: This ensures that even "Skipped" jobs report as a success to GitHub, preserving the green "All checks passed" status while saving significant CI minutes.

## Automated CI Summaries

To provide fast and actionable feedback, the CI pipeline automatically generates a summary of test results and code coverage.

- **Location**: Summaries are posted as a **GitHub Step Summary** in the Actions tab and as a **PR comment** on every pull request.
- **Content**: The summary includes pass/fail counts for unit tests and a tabular breakdown of code coverage (Statements, Branches, Functions, Lines).
- **Automation**: This is handled by `scripts/generate-ci-summary.mjs`, which parses the JUnit and JSON coverage reports. Run `npm run summary:ci` locally after `npm run test:cov` to see exactly what CI will post.

## Runtime monitoring

The backend reports runtime errors to Sentry. This worker does **not** — it has
no Sentry dependency and no DSN. Its operational signal is the scan attempt
row, which records every outcome including every failure, and the structured
logs described in [docs/worker-architecture.md](../worker-architecture.md).
Note the constraint in [docs/security.md](../security.md): filenames, file
contents and scanner signature names are never logged, so any monitoring added
later has to respect the same list.

## See Also

- [SECURITY-AUTOMATION.md](SECURITY-AUTOMATION.md) for security-specific automation details.
