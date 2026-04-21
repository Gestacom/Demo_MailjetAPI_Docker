#!/usr/bin/env sh
set -eu

mkdir -p "${APP_STORAGE_DIR:-/usr/src/app/storage}/accounts" "${APP_STORAGE_DIR:-/usr/src/app/storage}/locks" "${APP_LOGS_DIR:-/usr/src/app/logs}"

exec "$@"
