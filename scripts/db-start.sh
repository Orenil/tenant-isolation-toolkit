#!/usr/bin/env bash
# Stands up a local, throwaway Postgres cluster for running this project's
# test suite against real RLS. Unix-socket only (listen_addresses='') so it
# never binds a TCP port and can't collide with any other Postgres instance
# (local or another concurrent dev session) on the machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.pgdata/data"
SOCK_DIR="$ROOT/.pgdata/sock"
LOG_FILE="$ROOT/.pgdata/postgres.log"
DB_NAME="tenant_toolkit_test"

mkdir -p "$SOCK_DIR"

if [ ! -d "$DATA_DIR" ]; then
  echo "Initializing Postgres data directory at $DATA_DIR"
  initdb -D "$DATA_DIR" -U postgres --auth=trust --no-locale --encoding=UTF8 >/dev/null
fi

if ! pg_ctl -D "$DATA_DIR" status >/dev/null 2>&1; then
  echo "Starting Postgres (unix socket only, $SOCK_DIR)"
  pg_ctl -D "$DATA_DIR" -l "$LOG_FILE" -o "-c listen_addresses='' -c unix_socket_directories='$SOCK_DIR'" start
else
  echo "Postgres already running for this data dir"
fi

for _ in $(seq 1 30); do
  if psql -h "$SOCK_DIR" -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! psql -h "$SOCK_DIR" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "Creating database $DB_NAME"
  psql -h "$SOCK_DIR" -U postgres -d postgres -c "CREATE DATABASE $DB_NAME" >/dev/null
fi

echo "Applying schema"
psql -h "$SOCK_DIR" -U postgres -d "$DB_NAME" -f "$ROOT/db/schema.sql" >/dev/null

echo ""
echo "Postgres ready."
echo "  export PGHOST=$SOCK_DIR"
echo "  export PGUSER=tenant_app"
echo "  export PGDATABASE=$DB_NAME"
