#!/bin/sh
# Entrypoint for the render task. Starts a task-local Postgres, waits for it, then
# runs the render job. This is used by the AWS Batch job definition (command
# override); the image's default notebook entrypoint is unaffected.
set -e

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-unused}"
export PGDATA="${PGDATA:-/home/postgres/pgdata}"

nohup docker-entrypoint.sh postgres >/tmp/postgres.log 2>&1 &

while ! nc -z localhost 5432; do
  echo "waiting for postgres"
  sleep 1
done

exec python3 /home/postgres/render/render_job.py
