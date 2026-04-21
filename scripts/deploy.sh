#!/usr/bin/env sh
set -eu

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and set APP_TOKEN and APP_MASTER_KEY." >&2
  exit 1
fi

docker compose pull --ignore-pull-failures
docker compose up -d --build
docker compose ps
