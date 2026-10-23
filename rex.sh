#!/bin/sh
# remote-exec 统一入口：全部子命令走 Rust 客户端（rust/rex）。
# Node CLI 仅作为回滚资产保留在仓库（src/cli），不再被本入口路由。
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REX_BIN=${REX_BIN:-$SCRIPT_DIR/rust/target/x86_64-unknown-linux-musl/release/rex}
exec "$REX_BIN" "$@"
