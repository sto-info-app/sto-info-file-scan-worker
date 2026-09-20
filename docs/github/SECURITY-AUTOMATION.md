# Security Automation

This repository uses automated tools to ensure high security standards and community recognition.

The set below is deliberately a subset of the backend's. Two of the backend's
suites — property-based fuzzing and OWASP ZAP — target surfaces this worker
does not have, and the reasoning is recorded in
[SECURITY.md](../../SECURITY.md) rather than repeated here.

## OpenSSF Scorecard

We use the [OpenSSF Scorecard](https://scorecard.dev/) to automatically assess our security posture.

### What it does

- **Schedule**: Runs weekly (Sundays at 03:30 UTC) and on every push to the `development` branch.
- **Findings**: Results are uploaded to GitHub **Security** -> **Code scanning alerts**.
- **Workflow**: [.github/workflows/openssf-scorecard.yml](../../.github/workflows/openssf-scorecard.yml)

## CodeQL

CodeQL performs static analysis of the TypeScript sources.

- **Trigger**: On pull requests and pushes to `development` and `production`, and weekly (Mondays at 00:30 UTC).
- **Smart Skip**: A filter job skips the analysis when a PR changes no source, while still reporting success so branch protection is satisfied.
- **Results**: Alerts appear in the repository's [Security tab](../../security/code-scanning).
- **Workflow**: [.github/workflows/codeql.yml](../../.github/workflows/codeql.yml)

## GitHub Code Scanning

Code scanning is our central dashboard for security vulnerabilities found in the code.

- **Source**: Findings come from CodeQL and OpenSSF Scorecard via SARIF upload.
- **Location**: View alerts in the repository's [Security tab](../../security/code-scanning).
- **Automation**: Alerts are automatically updated when a workflow completes.

## Dependency Audit

- **Command**: `npm audit --audit-level=high --omit=dev` — the production tree only, at high severity and above.
- **Trigger**: On any PR touching `package.json` or `package-lock.json`, on push, and weekly (Sundays at midnight UTC).
- **Locally**: The same gate is the first step of `npm run verify`, so a failing audit is visible before a push rather than after one.
- **Workflow**: [.github/workflows/audit.yml](../../.github/workflows/audit.yml)

## Dependency Review

- **Trigger**: Every pull request.
- **What it does**: Blocks a PR that introduces a dependency carrying a known advisory, before it reaches the tree the audit gate measures.
- **Workflow**: [.github/workflows/dependency-review.yml](../../.github/workflows/dependency-review.yml)

## Dependabot

- **Schedule**: Daily, for both npm and GitHub Actions.
- **Grouping**: Minor and patch version updates are grouped into one PR per ecosystem; majors arrive individually so they can be assessed on their own.
- **CI**: The full pipeline is skipped on Dependabot PRs, matching the rest of the project. Dependency safety is covered instead by Dependabot alerts, the scheduled audit, and Dependency Review.
- **Config**: [.github/dependabot.yml](../../.github/dependabot.yml)

## Developer Certificate of Origin

- **Trigger**: Every pull request.
- **What it enforces**: Every commit carries a `Signed-off-by` trailer. A local `commit-msg` hook checks the same thing before the commit is written, so CI is a backstop rather than the first place you find out.
- **Workflow**: [.github/workflows/dco.yml](../../.github/workflows/dco.yml)

## SonarCloud

SonarCloud provides continuous inspection of code quality and security.

- **Security Hotspots**: Focuses on potential security risks that require human review.
- **Rules**: Checks against a wide range of security rules (OWASP Top 10, CWE, etc.).
- **Project**: `sto-info-app_sto-info-file-scan-worker`, configured in [sonar-project.properties](../../sonar-project.properties).

## Workflow Security

We enforce the principle of least privilege for our GitHub Actions workflows.

- **Default Permissions**: All workflows default to `permissions: {}` at the top level.
- **Job-Level Granularity**: Permissions are only granted at the job level for specific tasks (e.g., `contents: read` for fetching code, `security-events: write` for uploading CodeQL scans).
- **Pinned Actions**: Third-party actions are pinned to a full commit SHA with the version in a trailing comment, so a moved tag cannot change what runs.
- **Hardened Runners**: Workflows run on standard GitHub-hosted runners with automated smart-skipping to minimize the attack surface of continuous integration.

## Where to see results

- To see the latest security alerts, go to the [Security tab](../../security/code-scanning).
- To view the detailed Scorecard report, visit [scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/sto-info-app/sto-info-file-scan-worker).
