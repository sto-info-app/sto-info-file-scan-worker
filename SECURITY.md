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

The production audit gate (`npm audit --audit-level=high --omit=dev`) passes,
and `npm audit --omit=dev` reports **zero advisories at any severity** (last
verified 2026-11-13). The full audit (`npm audit`) reports one
development-only advisory with no patched release: `deepmerge`
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) (low,
prototype poisoning in `mergeObject()`, every version from `4.2.0` to
`4.3.1`), reached through `jest` → `jest-config`. `4.3.1` is the newest
`deepmerge`, so there is nothing to pin to; re-check with
`npm view deepmerge version`.

This repository carries three overrides:

- `qs` → `^6.17.1` (raised from `^6.17.0` on 2026-11-13 to track the current
  release), remediating
  [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26),
  [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx),
  [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) and
  [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
  `typed-rest-client@2.3.1` (via `@stryker-mutator/core`) exact-pins
  `qs@6.15.1`; the global override keeps the tree on a release patched
  against all four. Re-checked 2026-11-13: `@stryker-mutator/core@10.1.1` is
  still the newest Stryker and still pins `typed-rest-client@~2.3.0`, so the
  override stays until Stryker takes `typed-rest-client@3`.
- `glob@>=9.0.0 <14.0.2` → `^14.0.6` (added 2026-11-13), remediating
  [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
  (moderate; an aborted glob walk keeps traversing the filesystem). The
  advisory covers every release from `9.0.0` to `14.0.1` and was not
  backported. Development tree only: `test-exclude@7.0.2` (under
  `babel-plugin-istanbul`) asks for `glob@^10` and `@jest/reporters@30.5.2`
  for `glob@^13`. The key is scoped to the vulnerable range, so it stops
  matching, and can be deleted, once both ask for `14.0.2` or later.
- `minimatch@>=7.0.0 <11.0.1` → `^11.0.8` (added 2026-11-13), remediating
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
  (moderate; denial of service through pattern-part amplification). The
  advisory covers `7.0.0` to `11.0.0` and was not backported to the 9.x or
  10.x lines. Development tree only: `eslint@10.14.0`,
  `@eslint/config-array`, `@typescript-eslint/typescript-estree@8.72.2` and
  `@stryker-mutator/core@10.1.1` all ask for `minimatch@^10`. The same scoping
  applies: delete the entry when `npm ls minimatch` shows nothing below
  `11.0.1` without it.

Both scoped overrides move a dependency across a major version from what its
parent declared, so lint, the build and the full test suite with coverage
were run against them on 2026-11-13.

The `argparse` → `^2.0.1` override was removed on 2026-11-13. It existed to
drop `sprintf-js` from the tree for
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
which GitHub withdrew on 2026-10-22. `js-yaml@3` (under
`@istanbuljs/load-nyc-config`) is back on the `argparse@1` it declares, and
`npm audit` does not report it.

### TypeScript stays on `~6.0.3` (re-checked 2026-11-13)

Dependabot bumped `typescript` to `7.0.2` on 2026-09-21. The CI pipeline is
skipped on Dependabot PRs, so nothing caught that `nest build` fails outright
under it:

```
Error  The installed TypeScript version (7.0.2) does not expose the programmatic
compiler API that the Nest CLI requires. TypeScript 7.0 ships the "tsc"
executable only; the compiler API is expected to return in 7.1.
```

The 2026-10-06 revert to `^6.0.3` did not stick: Dependabot bumped it again on
2026-10-22, and lint failed with `typescript-eslint does not support TS 7.0`.
On 2026-10-27 the range was set to `~6.0.3` (matching the backend and
frontend), and `.github/dependabot.yml` now ignores TypeScript majors so it
cannot return unnoticed.

Three tools gate on TypeScript 6: `@nestjs/cli@12.0.13` (bundles
`typescript ~6.0.2`), `ts-jest@29.4.15` (peer `<7`) and
`@typescript-eslint/parser@8.72.2` (peer `<6.1.0`). The code itself is
ready: `tsconfig.json` no longer sets `baseUrl` or `ignoreDeprecations` (the
`src/*` alias is an explicit `paths` entry, and the one `config/` import is
now relative), and `npx -p typescript@7.0.2 tsc -p tsconfig.spec.json --noEmit`
reports no errors. Retry when all three admit TypeScript 7:

```sh
npm view @nestjs/cli@latest dependencies.typescript
npm view ts-jest@latest peerDependencies.typescript
npm view @typescript-eslint/parser@latest peerDependencies.typescript
```

### Runtime and CA trust (2026-10-27)

In October 2026 the private keys of eight eMudhra (emSign) intermediate
certificates were confirmed compromised, and Node.js shipped security
releases that distrust them and fix TLS hostname-check and Brotli flaws. The
worker moved to **Node.js `24.22.1`** (`.nvmrc`, the `Dockerfile` `ARG`, the
engine range and every workflow) and was rebuilt with a current Debian
`ca-certificates`. The SonarQube scan action was raised to `v8.4.0`. See
[docs/infrastructure.md](docs/infrastructure.md#base-image-and-certificate-trust)
for why the image needs both changes and how to verify them.

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
