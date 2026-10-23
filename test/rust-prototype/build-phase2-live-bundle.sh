#!/usr/bin/env bash
# 组装 Phase 2 实机验收 bundle（二进制 + 证书 + 两个版本包 + 驱动脚本）。
# 用法：build-phase2-live-bundle.sh --binary <remote-execd> --output-dir <dir>
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BINARY=''
OUTPUT_DIR=''
while (($#)); do
  case "$1" in
    --binary) BINARY="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$BINARY" && -n "$OUTPUT_DIR" ]] || { printf '用法：build-phase2-live-bundle.sh --binary <remote-execd> --output-dir <dir>\n' >&2; exit 2; }
BINARY="$(readlink -f "$BINARY")"
[[ -f "$BINARY" ]] || { printf '二进制不存在：%s\n' "$BINARY" >&2; exit 1; }
[[ ! -e "$OUTPUT_DIR" ]] || { printf '输出目录已存在：%s\n' "$OUTPUT_DIR" >&2; exit 1; }

for tool in openssl tar sha256sum; do
  command -v "$tool" >/dev/null || { printf '缺少 %s\n' "$tool" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/certs"

# 证书：CA + 服务证书（SAN 127.0.0.1，supervisor 与 daemon 同机回环）。
# basicConstraints=CA:TRUE 是 req -x509 默认行为（1.1.1 与 3.x 均如此），再 -addext
# 会在 openssl 1.1.1 上产生重复扩展被 rustls 拒绝；keyUsage 非默认，必须显式加。
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$STAGE/certs/ca.key" -out "$STAGE/certs/ca.crt" \
  -subj '/CN=rex-phase2-live CA' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$STAGE/certs/server.key" -out "$STAGE/server.csr" \
  -subj '/CN=127.0.0.1' >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$STAGE/san.ext"
openssl x509 -req -in "$STAGE/server.csr" \
  -CA "$STAGE/certs/ca.crt" -CAkey "$STAGE/certs/ca.key" -CAcreateserial \
  -days 365 -extfile "$STAGE/san.ext" -out "$STAGE/certs/server.crt" >/dev/null 2>&1
rm -f "$STAGE/certs/ca.key" "$STAGE/server.csr" "$STAGE/san.ext" "$STAGE/certs/ca.srl"
chmod 0644 "$STAGE/certs/"*

# token：daemon 鉴权凭据摘要（实机验收只用 /readyz，不消费 token）。
printf '%s' "rex-phase2-live-token" | sha256sum | cut -d' ' -f1 > "$STAGE/token.sha256"

# 二进制：supervisor/ctl 用根拷贝，版本包内各放一份。
install -m 0755 "$BINARY" "$STAGE/remote-execd"
for version in v1 v2 v3; do
  PKG="$STAGE/pkgsrc-$version"
  mkdir -p "$PKG/bin"
  install -m 0755 "$BINARY" "$PKG/bin/remote-execd"
  printf '%s\n' "$version" > "$PKG/marker"
  tar -czf "$STAGE/$version.tar.gz" -C "$PKG" .
  rm -rf "$PKG"
done

install -m 0644 "$PROJECT_ROOT/test/rust-prototype/phase2-live.py" "$STAGE/phase2-live.py"

mv "$STAGE" "$OUTPUT_DIR"
printf 'bundle 就绪：%s\n' "$OUTPUT_DIR"
