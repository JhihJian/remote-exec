#!/usr/bin/env bash
set -euo pipefail

DEFAULT_NODE_VERSION="24.13.1"
NODE_VERSION="${NODE_VERSION:-$DEFAULT_NODE_VERSION}"
OUTPUT_DIR="${PWD}/dist"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  printf '用法: %s [--output-dir DIR]\n' "$(basename "$0")" >&2
}

while (($#)); do
  case "$1" in
    --output-dir)
      (($# >= 2)) || { printf '%s\n' '--output-dir 需要目录参数' >&2; usage; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'NODE_VERSION 必须是 x.y.z 版本号: %s\n' "$NODE_VERSION" >&2
  exit 2
}

for command in node npm tar sha256sum find; do
  command -v "$command" >/dev/null || {
    printf '缺少构建依赖: %s\n' "$command" >&2
    exit 1
  }
done

PACKAGE_VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
ARCHIVE_NAME="remote-exec-linux-x64.tar.gz"
ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
NODE_ARCHIVE_NAME="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

BUILD_DIR="$(mktemp -d)"
DOWNLOAD_DIR=''
cleanup_build() { rm -rf "$BUILD_DIR"; if [[ -n "$DOWNLOAD_DIR" ]]; then rm -rf "$DOWNLOAD_DIR"; fi; }
trap cleanup_build EXIT

if [[ -n "${NODE_ARCHIVE:-}" ]]; then
  [[ -f "$NODE_ARCHIVE" ]] || { printf 'NODE_ARCHIVE 不存在: %s\n' "$NODE_ARCHIVE" >&2; exit 1; }
  [[ -n "${NODE_SHASUMS256:-}" && -f "$NODE_SHASUMS256" ]] || {
    printf '使用 NODE_ARCHIVE 时必须提供对应的 NODE_SHASUMS256 文件\n' >&2
    exit 1
  }
  NODE_ARCHIVE_PATH="$NODE_ARCHIVE"
  NODE_SHASUMS_PATH="$NODE_SHASUMS256"
else
  command -v curl >/dev/null || { printf '下载 Node 需要 curl\n' >&2; exit 1; }
  DOWNLOAD_DIR="$(mktemp -d)"
  NODE_ARCHIVE_PATH="${DOWNLOAD_DIR}/${NODE_ARCHIVE_NAME}"
  NODE_SHASUMS_PATH="${DOWNLOAD_DIR}/SHASUMS256.txt"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 180 --retry 2 "${NODE_BASE_URL}/${NODE_ARCHIVE_NAME}" --output "$NODE_ARCHIVE_PATH"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --retry 2 "${NODE_BASE_URL}/SHASUMS256.txt" --output "$NODE_SHASUMS_PATH"
fi

NODE_ARCHIVE_BASENAME="$(basename "$NODE_ARCHIVE_PATH")"
EXPECTED_NODE_CHECKSUM="$(awk -v name="$NODE_ARCHIVE_BASENAME" '$2 == name { print $1; exit }' "$NODE_SHASUMS_PATH")"
[[ "$EXPECTED_NODE_CHECKSUM" =~ ^[[:xdigit:]]{64}$ ]] || {
  printf '官方 SHASUMS256.txt 中没有 %s 的有效校验值\n' "$NODE_ARCHIVE_BASENAME" >&2
  exit 1
}
ACTUAL_NODE_CHECKSUM="$(sha256sum "$NODE_ARCHIVE_PATH" | awk '{print $1}')"
[[ "$ACTUAL_NODE_CHECKSUM" == "$EXPECTED_NODE_CHECKSUM" ]] || {
  printf 'Node 下载包校验失败: %s\n' "$NODE_ARCHIVE_BASENAME" >&2
  exit 1
}

PACKAGE_DIR="${BUILD_DIR}/package"
NODE_DIR="${BUILD_DIR}/node"
mkdir -p "$PACKAGE_DIR/src/daemon" "$PACKAGE_DIR/src/client" "$PACKAGE_DIR/packaging" "$PACKAGE_DIR/scripts" "$PACKAGE_DIR/runtime/bin" "$NODE_DIR"

cp -R --no-preserve=mode,ownership,links "$PROJECT_ROOT/src/daemon/." "$PACKAGE_DIR/src/daemon/"
cp --no-preserve=mode,ownership,links "$PROJECT_ROOT/src/client/websocket.js" "$PACKAGE_DIR/src/client/websocket.js"
cp --no-preserve=mode,ownership,links "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$PACKAGE_DIR/"
cp --no-preserve=mode,ownership,links "$PROJECT_ROOT/LICENSE" "$PACKAGE_DIR/LICENSE"
cp --no-preserve=mode,ownership,links "$PROJECT_ROOT/packaging/remote-exec.service" "$PACKAGE_DIR/packaging/remote-exec.service"
cp --no-preserve=mode,ownership,links "$PROJECT_ROOT/scripts/smoke.js" "$PACKAGE_DIR/scripts/smoke.js"

(
  cd "$PACKAGE_DIR"
  npm ci --omit=dev --ignore-scripts
  rm package-lock.json
)

tar -xJf "$NODE_ARCHIVE_PATH" --strip-components=1 -C "$NODE_DIR"
install -m 0755 "$NODE_DIR/bin/node" "$PACKAGE_DIR/runtime/bin/node"
cp --no-preserve=mode,ownership,links "$NODE_DIR/LICENSE" "$PACKAGE_DIR/runtime/LICENSE"
rm -rf "$NODE_DIR"

# 清单只记录发布版本与平台。
(
  cd "$PACKAGE_DIR"
  node -e 'const fs = require("fs"); const manifest = { version: process.argv[1], nodeVersion: process.argv[2], platform: "linux", arch: "x64" }; fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");' "$PACKAGE_VERSION" "$NODE_VERSION"
)

if find "$PACKAGE_DIR" -type l -print -quit | grep -q .; then
  printf '构建目录包含软链接，拒绝打包\n' >&2
  exit 1
fi
if find "$PACKAGE_DIR" -type f -links +1 -print -quit | grep -q .; then
  printf '构建目录包含硬链接，拒绝打包\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
tar -czf "$ARCHIVE_PATH" -C "$PACKAGE_DIR" .
(
  cd "$OUTPUT_DIR"
  sha256sum "$ARCHIVE_NAME" > "$(basename "$CHECKSUM_PATH")"
)
printf '已生成: %s\n校验文件: %s\n' "$ARCHIVE_PATH" "$CHECKSUM_PATH"
