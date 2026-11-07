#!/usr/bin/env bash
# Checks a built image the way it will be used, before .github/workflows/docker.yml
# publishes it. By hand, from the repo root:
#
#   docker build -t html-server:dev . && scripts/docker-smoke.sh html-server:dev
#
# Usage: scripts/docker-smoke.sh IMAGE [PLATFORM]   (PLATFORM e.g. linux/arm64, under QEMU)
#
# It checks: the version and Debian 13; a non-root user; the PostgreSQL driver loads;
# on SQLite, a first start makes an admin, the health check turns healthy, a page can be
# published, searched and survives a restart, and `docker stop` is quick; on PostgreSQL
# (a postgres:16 container), the same server with DATABASE_URL publishes and searches.
set -euo pipefail

image=${1:?usage: scripts/docker-smoke.sh IMAGE [PLATFORM]}
platform=(); [ -n "${2:-}" ] && platform=(--platform "$2")
run=smoke-$$
want=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
pg_password=smoke-only-password # a throwaway database on a private network, removed below

cleanup() {
  docker rm -f "$run-sqlite" "$run-pg" "$run-db" >/dev/null 2>&1 || true
  docker volume rm "$run-data" >/dev/null 2>&1 || true
  docker network rm "$run-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
# Whether TEXT contains PATTERN. Not `cmd | grep -q`: with pipefail, grep stopping at the
# first match can kill cmd with SIGPIPE and fail the pipeline though the text was there.
has() { grep -q -- "$1" <<< "$2"; }
in_image() { docker run --rm ${platform[@]+"${platform[@]}"} --entrypoint "$1" "$image" "${@:2}"; }

# Waits for the image's own HEALTHCHECK to report healthy; prints the logs if it doesn't.
healthy() {
  for _ in $(seq 1 60); do
    case $(docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$1") in
      'running healthy') return 0 ;;
      *unhealthy | exited* | dead*) break ;;
    esac
    sleep 2
  done
  docker logs "$1" >&2
  fail "$1 never became healthy"
}

got=$(docker run --rm ${platform[@]+"${platform[@]}"} "$image" --version)
[ "$got" = "$want" ] || fail "--version says $got, package.json $want"
ok "html-server $got"

debian=$(in_image cat /etc/debian_version)
case $debian in 13.*) ok "Debian $debian" ;; *) fail "expected Debian 13, got $debian" ;; esac

[ "$(in_image id -u)" != 0 ] || fail "runs as root"
ok "runs as $(in_image id -un)"

in_image node -e "require('pg-native')" || fail "the PostgreSQL driver doesn't load"
ok "pg-native loads"

# SQLite, in a named volume, as the README runs it.
docker volume create "$run-data" >/dev/null
docker run -d --name "$run-sqlite" ${platform[@]+"${platform[@]}"} -v "$run-data:/data" "$image" >/dev/null
healthy "$run-sqlite"
has "first run: created admin 'node'" "$(docker logs "$run-sqlite" 2>&1)" || fail "no first-run admin"
ok "SQLite: healthy, first-run admin made"
docker exec "$run-sqlite" sh -c 'printf "<h1>Smoke</h1><p>debian trixie container</p>" > /tmp/smoke.html && html-server put /tmp/smoke.html "smoke test"' >/dev/null
has smoke.html "$(docker exec "$run-sqlite" html-server search trixie)" || fail "SQLite: the page isn't found"
status=$(docker exec "$run-sqlite" node -e "fetch('http://127.0.0.1:8765/pages/smoke.html').then((r) => console.log(r.status))")
[ "$status" = 200 ] || fail "SQLite: /pages/smoke.html answered $status"
ok "SQLite: published, searched, served"

start=$(date +%s)
docker stop "$run-sqlite" >/dev/null
took=$(( $(date +%s) - start ))
[ "$took" -lt 8 ] || fail "docker stop took ${took}s: the signal isn't reaching Node"
docker start "$run-sqlite" >/dev/null
healthy "$run-sqlite"
has smoke.html "$(docker exec "$run-sqlite" html-server ls)" || fail "SQLite: the page didn't survive a restart"
[ "$(docker logs "$run-sqlite" 2>&1 | grep -c 'first run' || true)" = 1 ] || fail "SQLite: a second first-run admin"
ok "SQLite: stopped in ${took}s, kept its data across a restart"

# PostgreSQL, through DATABASE_URL.
docker network create "$run-net" >/dev/null
docker run -d --name "$run-db" --network "$run-net" -e POSTGRES_USER=html_server \
  -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=html_server postgres:16 >/dev/null
# Over TCP: while the image initializes the database, a temporary server answers on its
# socket only, then restarts.
for _ in $(seq 1 60); do
  docker exec "$run-db" pg_isready -q -h 127.0.0.1 -U html_server -d html_server 2>/dev/null && break
  sleep 1
done
docker run -d --name "$run-pg" ${platform[@]+"${platform[@]}"} --network "$run-net" \
  -e DATABASE_URL="postgres://html_server:$pg_password@$run-db:5432/html_server" "$image" >/dev/null
healthy "$run-pg"
logs=$(docker logs "$run-pg" 2>&1)
has 'db: PostgreSQL' "$logs" || fail "PostgreSQL: not the database in use"
! has "$pg_password" "$logs" || fail "PostgreSQL: the password is in the logs"
token=$(docker exec "$run-pg" html-server create-user smoke --admin)
found=$(docker exec -e HTML_SERVER_URL=http://127.0.0.1:8765 -e HTML_SERVER_TOKEN="$token" "$run-pg" sh -c \
  'printf "<h1>Smoke</h1><p>debian trixie postgres</p>" > /tmp/smoke.html && html-server put /tmp/smoke.html "smoke test" >/dev/null && html-server search postgres')
has smoke.html "$found" || fail "PostgreSQL: the page isn't found"
ok "PostgreSQL: healthy, published, searched"

echo "all checks passed: $image${2:+ ($2)}"
