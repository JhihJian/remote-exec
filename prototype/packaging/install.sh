#!/usr/bin/env bash
# 原型离线安装：复制到独立目录，不覆盖正式 daemon，不登记开机启动。
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${1:-${HOME:?缺少 HOME}/.local/share/remote-exec-rust-prototype}"
(($# <= 1)) || { printf '用法：install.sh [绝对安装目录]\n' >&2; exit 2; }
[[ "$PREFIX" == /* ]] || { printf '安装目录必须是绝对路径\n' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { printf '原型仅支持 Linux x86_64\n' >&2; exit 1; }
command -v bash >/dev/null || { printf '命令协议需要 Bash\n' >&2; exit 1; }
[[ ! -e "$PREFIX" ]] || { printf '安装目录已存在，请使用新目录，避免覆盖服务和凭据\n' >&2; exit 1; }
"$SOURCE/remote-exec-rust-prototype" --help >/dev/null
umask 077
mkdir -p "$(dirname "$PREFIX")"
STAGE="$(mktemp -d "$(dirname "$PREFIX")/.remote-exec-rust-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SOURCE/." "$STAGE/"
chmod 0700 "$STAGE" "$STAGE/credentials"
chmod 0600 "$STAGE/credentials/"*
# -T 防止目标路径被并发创建后移动到其内部，-n 保留并发创建的目录。
mv -T -n "$STAGE" "$PREFIX"
[[ ! -d "$STAGE" ]] || { printf '目标目录在安装过程中已被创建\n' >&2; exit 1; }
printf '原型已离线安装：%s\n启动：bash %q\n' "$PREFIX" "$PREFIX/run.sh"
