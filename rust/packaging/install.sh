#!/usr/bin/env bash
# 原型离线安装：复制到独立目录，不覆盖正式 daemon。
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD=0
if [[ "${1:-}" == "--systemd" ]]; then
  SYSTEMD=1
  shift
fi
PREFIX="${1:-${HOME:?缺少 HOME}/.local/share/remote-exec-prototype}"
(($# <= 1)) || { printf '用法：install.sh [--systemd] [绝对安装目录]\n' >&2; exit 2; }
[[ "$PREFIX" == /* ]] || { printf '安装目录必须是绝对路径\n' >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { printf '原型仅支持 Linux\n' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) EXPECTED_TARGET=x86_64-unknown-linux-musl ;;
  aarch64|arm64) EXPECTED_TARGET=aarch64-unknown-linux-musl ;;
  *) printf '不支持的 Linux 架构：%s\n' "$(uname -m)" >&2; exit 1 ;;
esac
[[ -f "$SOURCE/target" ]] || { printf '安装包缺少 target 清单\n' >&2; exit 1; }
read -r PACKAGE_TARGET < "$SOURCE/target"
[[ "$PACKAGE_TARGET" == "$EXPECTED_TARGET" ]] || {
  printf '安装包架构不匹配：目标需要 %s，包是 %s\n' "$EXPECTED_TARGET" "$PACKAGE_TARGET" >&2
  exit 1
}
command -v bash >/dev/null || { printf '命令协议需要 Bash\n' >&2; exit 1; }
if ((SYSTEMD)); then
  [[ "$(id -u)" == 0 ]] || { printf '--systemd 需要 root SSH 会话\n' >&2; exit 1; }
  command -v systemctl >/dev/null || { printf '--systemd 需要 systemctl\n' >&2; exit 1; }
  systemctl show --property=Version --value >/dev/null || { printf 'systemd 管理器不可用\n' >&2; exit 1; }
  [[ -f "$SOURCE/remote-exec-prototype.service" ]] || { printf '安装包缺少 systemd unit\n' >&2; exit 1; }
fi
[[ ! -e "$PREFIX" ]] || { printf '安装目录已存在，请使用新目录，避免覆盖服务和凭据\n' >&2; exit 1; }
"$SOURCE/remote-execd" --help >/dev/null
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
if ((SYSTEMD)); then
  UNIT_CONTENT="$(<"$PREFIX/remote-exec-prototype.service")"
  UNIT_CONTENT="${UNIT_CONTENT//@PREFIX@/$PREFIX}"
  printf '%s\n' "$UNIT_CONTENT" > /etc/systemd/system/remote-exec-prototype.service
  chmod 0644 /etc/systemd/system/remote-exec-prototype.service
  systemctl daemon-reload
  systemctl enable --now remote-exec-prototype.service
  systemctl is-active --quiet remote-exec-prototype.service || { printf 'systemd 服务启动失败\n' >&2; exit 1; }
  printf '原型已离线安装并启用 systemd：%s\n服务：remote-exec-prototype.service\n' "$PREFIX"
else
  printf '原型已离线安装：%s\n启动：bash %q\n' "$PREFIX" "$PREFIX/run.sh"
fi
