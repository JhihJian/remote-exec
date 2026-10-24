#!/bin/sh
# remote-exec 统一入口：核心命令走 rex，部署/升级/迁移走 rex-ops 扩展。
# Node CLI 仅作为回滚资产保留在仓库（src/cli），不再被本入口路由。
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REX_BIN=${REX_BIN:-$SCRIPT_DIR/rust/target/x86_64-unknown-linux-musl/release/rex}
case "${1:-}" in
  deploy|upgrade|migrate)
    REX_OPS_BIN=${REX_OPS_BIN:-$SCRIPT_DIR/rust/target/x86_64-unknown-linux-musl/release/rex-ops}
    if [ ! -x "$REX_OPS_BIN" ]; then
      printf '缺少运维扩展 rex-ops，请先构建 remote-exec-ops\n' >&2
      exit 1
    fi
    exec "$REX_OPS_BIN" "$@"
    ;;
  *) exec "$REX_BIN" "$@" ;;
esac
