# The file scan worker, with the scanner it depends on inside it.
#
# ADR-0005 chose ClamAV running as `clamd` beside this process rather than a
# scanning API, and ADR-0020 chose to build that on the Node image this
# repository already targets rather than on ClamAV's. The reasoning is that
# the application's runtime is the part that has to match `.nvmrc`, the
# backend and CI exactly, while the scanner only has to be a recent ClamAV —
# so the constraint that is exact picks the base, and the one that is loose
# is installed on top.
#
# Three processes run here, supervised by s6-overlay: `clamd`, `freshclam`
# and the worker. s6 rather than a shell script because two of the three are
# daemons with an ordering between them, and a container's PID 1 has to reap
# orphans and pass signals on properly or a deploy takes a scan down with it.
#
# **The worker does not wait for `clamd`.** It starts, finds the scanner
# unfit, and pauses its own queue until the health poll says otherwise —
# ADR-0020. That is why there is no readiness gate in this file: the
# application already has one, and a wait loop here would only duplicate it
# less well.

ARG NODE_VERSION=24.21.0
ARG S6_OVERLAY_VERSION=3.2.1.0

FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# The full dependency set, because the migration runner is `ts-node` and runs
# from source at start-up. Pruning to production here would save perhaps a
# hundred megabytes and break the first thing the container does.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY config ./config
COPY src ./src

RUN npm run build


FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG S6_OVERLAY_VERSION
ARG TARGETARCH

ENV NODE_ENV=production \
    TZ=UTC \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0

# clamav-daemon brings clamd, clamav-freshclam brings the updater. xz-utils
# and ca-certificates are needed to unpack s6 and to reach the signature
# mirrors respectively; both stay, because freshclam needs the certificates
# for the life of the container.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes \
    ca-certificates \
    clamav-daemon \
    clamav-freshclam \
    curl \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# s6-overlay ships one architecture-neutral tarball and one per architecture.
# The Debian names for architectures are not s6's, hence the mapping.
RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) s6_arch='x86_64' ;; \
    arm64) s6_arch='aarch64' ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  for part in "noarch" "${s6_arch}"; do \
    curl -fsSLO "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${part}.tar.xz"; \
    tar -C / -Jxpf "s6-overlay-${part}.tar.xz"; \
    rm "s6-overlay-${part}.tar.xz"; \
  done

COPY docker/clamd.conf /etc/clamav/clamd.conf
COPY docker/freshclam.conf /etc/clamav/freshclam.conf
COPY docker/s6-rc.d /etc/s6-overlay/s6-rc.d

# The execute bit is set here rather than relied upon from the repository.
# It is a file mode travelling through Git on Windows, and a service script
# that arrives without it fails at start-up with an error that says nothing
# about why.
RUN chmod +x \
  /etc/s6-overlay/s6-rc.d/clamd/run \
  /etc/s6-overlay/s6-rc.d/freshclam/run \
  /etc/s6-overlay/s6-rc.d/migrate/up \
  /etc/s6-overlay/s6-rc.d/worker/run \
  /etc/s6-overlay/s6-rc.d/worker/finish

# The signature database, baked in. It is roughly a gigabyte and the first
# download takes minutes, during which the worker is unfit and scans nothing
# — so an image that carries one starts working immediately and an image that
# does not is useless until it has finished downloading. freshclam updates it
# on start and on its cadence regardless, and the age policy
# (CLAMAV_MAX_DEFINITION_AGE_HOURS) refuses to scan with what is in here if a
# deploy is old enough that the update has not landed yet. ADR-0020.
RUN install -d -o clamav -g clamav /var/lib/clamav \
  && freshclam --config-file=/etc/clamav/freshclam.conf --foreground --stdout \
  && chown -R clamav:clamav /var/lib/clamav

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json tsconfig.json ./
COPY config ./config
COPY src/database/migrations ./src/database/migrations
COPY src/config ./src/config
COPY src/contract ./src/contract

# The health endpoint, for a human and for whatever this is deployed as. A
# Render background worker probes nothing, so nothing depends on this being
# published — the worker polices itself.
EXPOSE 3000

ENTRYPOINT ["/init"]
