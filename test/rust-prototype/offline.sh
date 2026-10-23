#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCH="${RUST_PROTOTYPE_ARCH:-x64}"
TARGET="${RUST_PROTOTYPE_TARGET:-x86_64-unknown-linux-musl}"
PACKAGE="${RUST_PROTOTYPE_PACKAGE:-$ROOT/dist/rust-prototype/remote-exec-prototype-linux-${ARCH}.tar.gz}"
IMAGE="${RUST_PROTOTYPE_OFFLINE_IMAGE:-debian:12-slim}"
[[ -f "$PACKAGE" ]] || { printf '请先构建完整 Rust 原型包\n' >&2; exit 1; }
BYTES="$(wc -c < "$PACKAGE")"
((BYTES < 2000000)) || { printf '完整包超过 2MB：%s 字节\n' "$BYTES" >&2; exit 1; }
(cd "$(dirname "$PACKAGE")" && sha256sum --check "$(basename "$PACKAGE").sha256")
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$PACKAGE" -C "$STAGE"
[[ ! -f "$STAGE/credentials/token.txt" ]] || { printf '服务包不应包含客户端 token 明文\n' >&2; exit 1; }
[[ "$(cat "$STAGE/target")" == "$TARGET" ]] || { printf '包 target 清单错误\n' >&2; exit 1; }
[[ -f "$STAGE/remote-exec-rust.service" ]] || { printf '包缺少 systemd unit\n' >&2; exit 1; }
if readelf -l "$STAGE/remote-execd" | grep -q INTERP || readelf -d "$STAGE/remote-execd" | grep -q NEEDED; then
  printf '产物不是完全静态链接\n' >&2; exit 1
fi
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$STAGE,dst=/bundle,readonly" \
  --tmpfs /app:rw,exec,nosuid,mode=1777,size=32m \
  "$IMAGE" bash -eu -c '
    for command in node npm cargo rustc openssl; do
      if command -v "$command" >/dev/null; then
        printf "测试环境意外包含依赖：%s\n" "$command" >&2
        exit 1
      fi
    done
    bash /bundle/install.sh /app/installed
    if bash /bundle/install.sh /app/installed >/app/reinstall.log 2>&1; then
      printf "重复安装不应覆盖既有目录\n" >&2
      exit 1
    fi
    bash /app/installed/run.sh > /app/server.log 2>&1 &
    server_pid=$!
    trap "kill $server_pid 2>/dev/null || true" EXIT
    for i in {1..100}; do
      if grep -q "listening 0.0.0.0:" /app/server.log; then break; fi
      if ! kill -0 "$server_pid" 2>/dev/null; then cat /app/server.log >&2; exit 1; fi
      sleep 0.05
    done
    grep "listening 0.0.0.0:" /app/server.log
    test "$(stat -c %a /app/installed/credentials/server.key)" = 600
    kill -TERM "$server_pid"
    wait "$server_pid"
    trap - EXIT
    printf "PASS 无网络、无 Node/OpenSSL/Cargo 环境离线安装与启动\n"
  '
printf 'PASS 完整服务器包 %s 字节，静态链接与体积门禁通过\n' "$BYTES"
