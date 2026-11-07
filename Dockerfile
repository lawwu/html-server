# syntax=docker/dockerfile:1
# HTML Server on Debian 13 (trixie) and Node 24, published to ghcr.io/lawwu/html-server
# by .github/workflows/docker.yml. Both stages start from the same official Node image,
# pinned by digest; Dependabot proposes newer ones (Node 24 only: majors wait for a person).
#
#   docker run -d --name html-server -p 127.0.0.1:8765:8765 -v html-server:/data ghcr.io/lawwu/html-server
#
# SQLite in the /data volume by default; set DATABASE_URL for PostgreSQL (README: Docker).

# Build: production dependencies only, with pg-native compiled against Debian's libpq.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 libpq-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# package.json allows libpq's build script. pg-native is optional, so npm would skip it
# quietly if it failed to build: check that it loads.
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e "require('pg-native')"

# Run: the code, its dependencies, libpq, and nothing to build with.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
# libpq5 for PostgreSQL, ca-certificates for its sslrootcert=system, tini to pass
# `docker stop` on to Node (as PID 1, Node would ignore it and be killed 10 s later).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY public ./public
COPY gallery ./gallery
# Data, the CLI's login and backups live in /data, owned by the image's unprivileged
# `node` user (uid 1000). The first start on an empty volume makes an admin named `node`.
ENV HTML_SERVER_HOME=/data
RUN ln -s /app/src/cli.js /usr/local/bin/html-server \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "html-server"]
# Inside its container the server has to listen on every interface for -p to reach it.
CMD ["serve", "--host", "0.0.0.0"]
