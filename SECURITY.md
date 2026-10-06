# Security Policy

This file is the repository's security *policy*: how vulnerabilities are
reported, which versions are supported, and what runs automatically against
every change. What the worker process itself is allowed to do — its
credentials, what it never logs, why it fails closed — is in
[docs/security.md](docs/security.md), and that is the document to read before
changing the scanning pipeline.

## Required Status Checks & "Smart Skips"

To maintain high standards without making the development process frustrating, we use a "Smart Skip" strategy for our required PR checks.

- **Behavior**: All required workflows (`Lint and Test`, `Audit`, `CodeQL`, etc.) trigger on every PR to `development` and `production` to ensure status checks are never "stuck."
- **Efficiency**: A lightweight filter job identifies if relevant code was changed. If only documentation, READMEs, or configs were updated, the heavy jobs are skipped.
- **Compliance**: This ensures that even "Skipped" jobs report as a success to GitHub, preserving the green "All checks passed" status while saving significant CI minutes.

## Workflow Security

We enforce the principle of least privilege for our GitHub Actions workflows.

- **Default Permissions**: All workflows default to `permissions: {}` at the top level.
- **Job-Level Granularity**: Permissions are only granted at the job level for specific tasks (e.g., `contents: read` for fetching code, `security-events: write` for uploading CodeQL scans).
- **Pinned Actions**: Every third-party action is pinned to a full commit SHA with the version in a trailing comment, so a moved tag cannot change what runs.
- **Hardened Runners**: Workflows run on standard GitHub-hosted runners with automated smart-skipping to minimize the attack surface of continuous integration.

## Supported Versions

We provide security updates for the following versions:

| Version         | Supported                           |
| --------------- | ----------------------------------- |
| `development`   | :white_check_mark: (Ongoing)        |
| Production Tags | :white_check_mark: (Latest release) |

The `development` branch is the primary target for all security fixes. Production releases are tagged and should be considered the latest stable state.

## Automated Security Testing

This repository employs several layers of automated testing to identify
vulnerabilities early in the development lifecycle.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [Dependency Audit](.github/workflows/audit.yml) | PR touching `package.json`/`package-lock.json`, push, daily schedule | `npm audit --audit-level=high --omit=dev`, the same gate `npm run verify` runs locally |
| [CodeQL](.github/workflows/codeql.yml) | PR, push, schedule | Static analysis of the TypeScript sources |
| [Dependency Review](.github/workflows/dependency-review.yml) | PR | Blocks a PR that introduces a dependency with a known advisory |
| [OpenSSF Scorecard](.github/workflows/openssf-scorecard.yml) | Schedule | Supply-chain posture of the repository itself |
| [DCO](.github/workflows/dco.yml) | PR | Every commit carries a `Signed-off-by` trailer |
| [Mutation Testing](.github/workflows/mutation-testing.yml) and [incremental](.github/workflows/mutation-testing-incremental.yml) | Weekly schedule, and per-PR on changed files | Stryker, proving the 100% coverage gate is real rather than nominal |

### What this repository does not run, and why

The backend runs two further suites that are deliberately absent here:

- **Property-based fuzz testing (`fast-check`)** targets the backend's request
  parsing and validation. This worker parses no user-supplied request bodies —
  a job message carries an asset identifier, an object key, an object version,
  a hash and a policy version, all produced by the backend, and never a URL,
  bucket, endpoint or credential. See "No arbitrary fetches" in
  [docs/security.md](docs/security.md).
- **OWASP ZAP DAST scanning** targets an HTTP API. This worker exposes one
  health endpoint and no API surface for a dynamic scanner to exercise.

Both become worth adding the moment either of those statements stops being
true.

### Continuous updates

Dependencies and GitHub Actions are updated by Dependabot on a daily schedule
([.github/dependabot.yml](.github/dependabot.yml)), with minor and patch
updates grouped into a single PR per ecosystem.

## Known Dependency Advisory Follow-up

Both the full dependency audit (`npm audit`) and the production audit gate
(`npm audit --audit-level=high --omit=dev`) pass with **zero advisories at any
severity** (last verified 2026-10-06).

This repository carries two overrides:

- `qs` → `^6.16.0`, remediating
  [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26),
  [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and
  [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
  `typed-rest-client@2.3.1` (via `@stryker-mutator/core`) exact-pins
  `qs@6.15.1`; the global override keeps the tree on `6.16.0`, the first
  release patched against all three. This matches the backend's override
  exactly. Re-checked 2026-10-06: `typed-rest-client@3.1.2` has moved to
  `qs@^6.16.0`, but `@stryker-mutator/core@10.0.0` still pins `~2.3.0`, so the
  override stays until Stryker takes `typed-rest-client@3`.
- `argparse` → `^2.0.1`, remediating
  [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
  (`sprintf-js`, development tree only). Every published `sprintf-js` release is
  affected, so no pin can help; the only consumer is `argparse@1`, reached
  through `ts-jest` → `@jest/transform` → `babel-plugin-istanbul` →
  `@istanbuljs/load-nyc-config@1.1.0` → `js-yaml@3`. `argparse@2` dropped
  `sprintf-js`, and `js-yaml@3` only requires `argparse` from its `bin/js-yaml.js`
  CLI, which nothing in this project runs — the library code in `lib/` never
  loads it. The override therefore removes `sprintf-js` from the tree without
  changing any code path that runs. Remove it when
  `@istanbuljs/load-nyc-config` publishes a release on `js-yaml@4`
  (`npm view @istanbuljs/load-nyc-config@latest dependencies.js-yaml`).

### TypeScript stays on `^6.0.3` (2026-10-06)

Dependabot bumped `typescript` to `7.0.2` on 2026-09-21. The CI pipeline is
skipped on Dependabot PRs, so nothing caught that `nest build` fails outright
under it:

```
Error  The installed TypeScript version (7.0.2) does not expose the programmatic
compiler API that the Nest CLI requires. TypeScript 7.0 ships the "tsc"
executable only; the compiler API is expected to return in 7.1.
```

`ts-jest@29.4.14` also declares `peerDependencies.typescript` as `>=4.3 <7`.
The pin was reverted to `^6.0.3`, matching the backend and frontend. Retry when
`@nestjs/cli` depends on a TypeScript 7 compiler and `ts-jest` admits it:

```sh
npm view @nestjs/cli@latest dependencies.typescript
npm view ts-jest@latest peerDependencies.typescript
```

Eleven further overrides (`@babel/core`, `diff`, `form-data`, `handlebars`,
`js-yaml`, `lodash`, `multer`, `path-to-regexp`, `picomatch`,
`serialize-javascript`, `uuid`) were removed on 2026-09-19 after each was
checked against the resolved tree. Four named packages that are not in the
dependency tree at all; four duplicated the version npm already resolved; and
two — `multer` and `picomatch` — were holding packages *below* the version
their own parents asked for, `multer@2.2.0` against the `2.4.0` that
`@nestjs/platform-express` requires. Removing them raised every affected
package and lowered none.

### Removal criteria

An override earns its place only while all three hold:

1. An advisory exists against the version npm would otherwise resolve.
2. No upstream release fixes it without a breaking change.
3. The pinned version is at or above what every consumer in the tree requests.

When any one stops holding, delete the entry and re-run the verification
commands below.

### Non-breaking remediation strategy

1. Prefer upstream patch adoption over `npm audit fix --force` (which can propose breaking package jumps).
2. Where upstream pins a vulnerable transitive version, use a minimal `overrides` entry subject to the criteria above.
3. Re-evaluate at each Dependabot PR and remove any temporary constraints once a safe non-breaking path is available.

### Verification command

```bash
npm audit
npm audit --audit-level=high --omit=dev
```

## Reporting a Vulnerability

If you believe you have discovered a security vulnerability, please report it privately through one of the following channels:

- **GitHub Private Reporting**: Use the "Report a vulnerability" button on the [Security tab](https://github.com/sto-info-app/sto-info-file-scan-worker/security/advisories/new).
- **Email**: Send a report to [security@startrekonline.info](mailto:security@startrekonline.info).

### What not to include publicly

Please do **not** create public issues for security vulnerabilities. Avoid including sensitive data such as:

- Production credentials or API keys.
- Personally Identifiable Information (PII).
- Detailed exploit code that could be used maliciously before a fix is available.

A note specific to this repository: **every quarantine bucket credential is a
production credential**, whichever environment issued it, because R2 cannot
scope a token below bucket level. Treat one that appears in a report as live.

### What to expect

- We will acknowledge receipt of your report within 48 hours.
- We will provide an estimated timeline for a fix and keep you updated on progress.
- We follow a coordinated disclosure process; we ask that you do not disclose the vulnerability publicly until a fix has been released.
