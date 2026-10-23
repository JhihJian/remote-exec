#!/usr/bin/env bash
# remote-exec 全局入口
#   rex / rex <主机名> / rex hosts / rex exec|read|write|upload|download|smoke
#   走 Rust 客户端（rust/rex）；rex deploy 暂仍走 Node（Phase 3b 迁移）。
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = "deploy" ]; then
  exec node "$SCRIPT_DIR/src/cli/main.js" "$@"
fi
REX_BIN=${REX_BIN:-$SCRIPT_DIR/rust/target/x86_64-unknown-linux-musl/release/rex}
exec "$REX_BIN" "$@"
