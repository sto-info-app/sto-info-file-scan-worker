#!/usr/bin/env bash
#
# Rehearses the clamd client against a real, throwaway clamd.
#
# The same argument as the migration rehearsal, applied to the other half of
# the worker. Everything a unit spec can prove about `ClamdScanEngineService`
# is a property of how it treats a socket a fake was told to misbehave on.
# Whether a real `clamd` says what the client thinks it says — the shape of
# its `VERSION` reply, what it returns at its stream limit, what a detection
# actually looks like — is a different question, and it is the one that
# decides whether anything ever gets scanned.
#
# It talks only to the container it started. It reads no scanner environment
# variable, so a stray .env cannot point it at a real clamd, and both the
# container and the image are removed on exit, including on failure or
# interrupt.
#
# The configuration is the deployed one, with a single difference: the
# driver runs on the host rather than inside the container, so `TCPAddr` is
# rewritten from loopback to any-address. That is the only line about the
# deployed scanner this cannot exercise, and it is the line that exists
# because in the deployment the two are in the same container.
#
# **The configuration is baked into a throwaway image rather than
# bind-mounted, and that is not a style choice.** On Windows, Git Bash
# rewrites both halves of a `-v` argument as though they were paths it
# owned: the first version of this script mounted the file to
# `/Program Files/Git/etc/clamav/clamd.conf`, the container quietly fell
# back to its own configuration, and the rehearsal reported passes for a
# scanner it had not configured. A build has no path to mangle, and the
# limits the scanner ends up with are printed below rather than assumed.
#
# Usage:
#   bash scripts/scan-rehearsal/run-rehearsal.sh
#
# Environment:
#   REHEARSAL_CLAMAV_IMAGE  the image to build on. Defaults to the public
#                           ClamAV image. Point it at a locally built
#                           `stoi-file-scan-worker` to rehearse against the
#                           exact container this repository deploys.
#   REHEARSAL_CLAMAV_PORT   the host port to publish on. Default 3390, so a
#                           rehearsal cannot collide with a local stack's
#                           clamd on 3310.
#
set -euo pipefail

CLAMAV_IMAGE="${REHEARSAL_CLAMAV_IMAGE:-clamav/clamav:stable}"
PORT="${REHEARSAL_CLAMAV_PORT:-3390}"
CONTAINER="worker-scan-rehearsal-$$"
IMAGE="worker-scan-rehearsal:$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

step() { printf '\n=== %s ===\n' "$1"; }

if ! docker version >/dev/null 2>&1; then
  echo 'Docker is not available; this rehearsal needs it.' >&2
  exit 1
fi

cd "${REPO}"

if ! grep -q '^TCPAddr 127\.0\.0\.1$' docker/clamd.conf; then
  echo 'docker/clamd.conf no longer binds loopback as expected' >&2
  exit 1
fi

step "Building a rehearsal image on ${CLAMAV_IMAGE}"
docker build -t "${IMAGE}" -f - . >/dev/null <<DOCKERFILE
FROM ${CLAMAV_IMAGE}
COPY docker/clamd.conf /etc/clamav/clamd.conf
RUN sed -i 's/^TCPAddr 127\.0\.0\.1\$/TCPAddr 0.0.0.0/' /etc/clamav/clamd.conf \\
 && grep -q '^TCPAddr 0\.0\.0\.0\$' /etc/clamav/clamd.conf
# The scanner, and nothing else. Both candidate images start more than
# clamd when left to their own entrypoints: the public one also runs
# freshclam, and this repository's runs s6, which runs the migrations and
# the worker and halts the container when they cannot reach a database
# that is not part of this rehearsal. Declaring it in the image rather
# than passing it to \`docker run\` also keeps these paths away from Git
# Bash, which rewrites them.
ENTRYPOINT ["/usr/sbin/clamd", "--config-file=/etc/clamav/clamd.conf"]
DOCKERFILE

step 'Starting it'
docker run -d --name "${CONTAINER}" -p "${PORT}:3310" "${IMAGE}" >/dev/null

# Three consecutive answers, for the same reason the migration rehearsal
# insists on them: a daemon still loading its database answers once and then
# stops while it reloads.
#
# Asked over the published port from here rather than with `clamdscan`
# inside the container. `clamdscan` belongs to a package this repository's
# own image does not install, so a probe that used it would work against the
# public image and fail against the one we deploy — which is the image most
# worth rehearsing against.
step 'Waiting for the scanner to answer'
ready=0
waited=0
until [ "${ready}" -ge 3 ]; do
  if node "${HERE}/ping.js" "${PORT}" >/dev/null 2>&1; then
    ready=$((ready + 1))
  else
    ready=0
  fi

  waited=$((waited + 1))
  if [ "${waited}" -gt 300 ]; then
    echo 'The scanner never answered.' >&2
    docker logs "${CONTAINER}" 2>&1 | tail -20 >&2
    exit 1
  fi

  sleep 1
done
echo "The scanner answered three times in a row after ${waited}s"

# Printed, not assumed. See the note above about the mount that never
# arrived: the limits below are what the assertions are being made against.
step 'The limits it is running with'
docker exec "${CONTAINER}" sh -c \
  "grep -E '^(TCPAddr|StreamMaxLength|MaxFileSize|MaxScanSize|MaxRecursion|MaxFiles|MaxScanTime|AlertExceedsMax)' /etc/clamav/clamd.conf"

step 'Rehearsing'
REHEARSAL_CLAMAV_HOST=127.0.0.1 REHEARSAL_CLAMAV_PORT="${PORT}" \
  REHEARSAL_CLAMAV_CONTAINER="${CONTAINER}" \
  npx ts-node -r tsconfig-paths/register "${HERE}/rehearse.ts"

printf '\nSCAN REHEARSAL COMPLETE on %s\n' "${CLAMAV_IMAGE}"
