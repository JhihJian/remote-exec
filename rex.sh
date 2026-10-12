#!/usr/bin/env bash
# remote-exec 全局入口
#   rex              交互式 TUI（列出主机选择）
#   rex <主机名>      直连指定主机
#   rex hosts        列出全部主机并探测连通延迟
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/src/cli/main.js" "$@"
