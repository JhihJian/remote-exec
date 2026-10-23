#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IFS= read -r PORT < "$ROOT/port"
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && ((PORT <= 65535)) || { printf 'port 文件无效\n' >&2; exit 1; }
exec "$ROOT/remote-execd" --host 0.0.0.0 --port "$PORT" \
  --cert "$ROOT/credentials/server.crt" --key "$ROOT/credentials/server.key" \
  --token-sha256-file "$ROOT/credentials/token.sha256"
