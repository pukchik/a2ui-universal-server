#!/usr/bin/env bash
set -euo pipefail

# A private cluster per invocation; no TCP listener on the host-network runner.
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
"$PG_BIN/postgres" --version
runtime_dir=$(mktemp -d /tmp/a2ui-ci-postgres.XXXXXX)
pg_command() {
  if [ "$(id -u)" = 0 ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}
if [ "$(id -u)" = 0 ]; then
  chown postgres "$runtime_dir"
fi
started=false
cleanup() {
  result=$?
  trap - EXIT
  if "$started"; then
    if ! pg_command "$PG_BIN/pg_ctl" -D "$runtime_dir/data" -m fast -w stop; then
      echo 'Failed to stop the CI PostgreSQL cluster' >&2
      result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pg_command "$PG_BIN/initdb" -D "$runtime_dir/data" --username=a2ui_ci --no-locale --encoding=UTF8 --auth-local=trust --auth-host=reject
pg_command mkdir "$runtime_dir/socket"
printf "listen_addresses = ''\nunix_socket_directories = '%s/socket'\n" "$runtime_dir" >> "$runtime_dir/data/postgresql.conf"
pg_command "$PG_BIN/pg_ctl" -D "$runtime_dir/data" -l "$runtime_dir/postgres.log" -w start
started=true
"$PG_BIN/createdb" -h "$runtime_dir/socket" -U a2ui_ci a2ui_test
export TEST_DATABASE_URL="postgresql://a2ui_ci@localhost/a2ui_test?host=$runtime_dir/socket"
pnpm test
