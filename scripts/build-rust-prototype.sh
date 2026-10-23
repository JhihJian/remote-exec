#!/usr/bin/env bash
# 仅在有构建依赖的部署端运行。目标设备不执行 Cargo 或 OpenSSL。
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/dist/rust-prototype"
ADDRESS=''
PORT=8791
TARGET="${RUST_TARGET:-x86_64-unknown-linux-musl}"
RUST_CC="${RUST_CC:-}"
RUST_LINKER="${RUST_LINKER:-}"
LIMIT=2000000
while (($#)); do
  case "$1" in
    --address|--port|--output-dir|--target|--cc|--linker)
      (($# >= 2)) || { printf '%s 需要参数\n' "$1" >&2; exit 2; }
      case "$1" in
        --address) ADDRESS="$2" ;;
        --port) PORT="$2" ;;
        --output-dir) OUTPUT_DIR="$2" ;;
        --target) TARGET="$2" ;;
        --cc) RUST_CC="$2" ;;
        --linker) RUST_LINKER="$2" ;;
      esac
      shift 2 ;;
    --help|-h)
      printf '%s\n' '用法：build-rust-prototype.sh --address DNS或IPv4 [--port 8791] [--output-dir DIR] [--target TARGET] [--cc COMPILER] [--linker LINKER]'
      exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in
  x86_64-unknown-linux-musl) ARCH=x64; DEFAULT_CC=musl-gcc ;;
  aarch64-unknown-linux-musl) ARCH=arm64; DEFAULT_CC=aarch64-linux-musl-gcc ;;
  *) printf '不支持的 Rust target：%s（仅支持 x86_64-unknown-linux-musl 和 aarch64-unknown-linux-musl）\n' "$TARGET" >&2; exit 2 ;;
esac
RUST_CC="${RUST_CC:-$DEFAULT_CC}"
RUST_LINKER="${RUST_LINKER:-$RUST_CC}"
[[ "$ADDRESS" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && ${#ADDRESS} -le 253 ]] || { printf '需要有效的 --address DNS 名或 IPv4\n' >&2; exit 2; }
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && ((PORT <= 65535)) || { printf 'port 必须是 1-65535\n' >&2; exit 2; }
if [[ "$ADDRESS" =~ ^[0-9.]+$ ]]; then
  IFS=. read -r -a octets <<< "$ADDRESS"
  ((${#octets[@]} == 4)) || { printf 'IPv4 无效\n' >&2; exit 2; }
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && ((10#$octet <= 255)) || { printf 'IPv4 无效\n' >&2; exit 2; }
  done
  SAN="DNS:localhost,IP:127.0.0.1,IP:$ADDRESS"
else
  IFS=. read -r -a labels <<< "$ADDRESS"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || { printf 'DNS 名无效\n' >&2; exit 2; }
  done
  SAN="DNS:localhost,IP:127.0.0.1,DNS:$ADDRESS"
fi
for tool in cargo rustc "$RUST_CC" "$RUST_LINKER" openssl tar gzip sha256sum readelf node; do
  command -v "$tool" >/dev/null || { printf '构建端缺少：%s\n' "$tool" >&2; exit 1; }
done
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
ARCHIVE="$OUTPUT_DIR/remote-exec-prototype-linux-${ARCH}.tar.gz"
[[ ! -e "$ARCHIVE" && ! -e "$OUTPUT_DIR/access" ]] || { printf '输出目录已有部署资产，请指定新目录，避免轮换既有凭据\n' >&2; exit 1; }
CC_TARGET_ENV="${TARGET//-/_}"
export "CC_${CC_TARGET_ENV}=$RUST_CC"
TARGET_ENV="${TARGET^^}"
TARGET_ENV="${TARGET_ENV//-/_}"
export "CARGO_TARGET_${TARGET_ENV}_LINKER=$RUST_LINKER"
cargo build --release --locked \
  --target "$TARGET" --manifest-path "$PROJECT_ROOT/rust/daemon/Cargo.toml"
BINARY="$PROJECT_ROOT/rust/target/$TARGET/release/remote-execd"
if readelf -l "$BINARY" | grep -q 'INTERP' || readelf -d "$BINARY" | grep -q 'NEEDED'; then
  printf '构建产物包含动态解释器或动态库依赖\n' >&2; exit 1
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
umask 077
mkdir -p "$STAGE/package/credentials" "$STAGE/access"
install -m 0755 "$BINARY" "$STAGE/package/remote-execd"
install -m 0755 "$PROJECT_ROOT/rust/packaging/run.sh" "$STAGE/package/run.sh"
install -m 0755 "$PROJECT_ROOT/rust/packaging/install.sh" "$STAGE/package/install.sh"
install -m 0644 "$PROJECT_ROOT/LICENSE" "$STAGE/package/LICENSE"
install -m 0644 "$PROJECT_ROOT/rust/packaging/remote-exec-prototype.service" "$STAGE/package/remote-exec-prototype.service"
printf '%s\n' "$TARGET" > "$STAGE/package/target"
cargo metadata --offline --locked --format-version 1 --filter-platform "$TARGET" \
  --manifest-path "$PROJECT_ROOT/rust/daemon/Cargo.toml" > "$STAGE/metadata.json"
node - "$STAGE/metadata.json" "$STAGE/package/THIRD_PARTY_LICENSES.txt" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sections = [];
for (const pkg of metadata.packages.filter(p => p.source).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.dirname(pkg.manifest_path);
  const files = fs.readdirSync(dir).filter(name => /^(LICENSE|COPYING|NOTICE)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
  if (!files.length) throw new Error(`依赖缺少许可证文件：${pkg.name}`);
  sections.push(`${pkg.name} ${pkg.version} (${pkg.license || '见许可证'})\n` +
    files.map(name => `${name}\n${fs.readFileSync(path.join(dir, name), 'utf8')}`).join('\n'));
}
fs.writeFileSync(process.argv[3], sections.join('\n\n') + '\n');
NODE
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$STAGE/ca.key" -out "$STAGE/ca.crt" \
  -subj '/CN=remote-exec-prototype CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$STAGE/package/credentials/server.key" -out "$STAGE/server.csr" \
  -subj '/CN=remote-exec-prototype' >/dev/null 2>&1
printf 'basicConstraints=critical,CA:FALSE\nsubjectAltName=%s\n' "$SAN" > "$STAGE/server.ext"
openssl x509 -req -days 365 -in "$STAGE/server.csr" \
  -CA "$STAGE/ca.crt" -CAkey "$STAGE/ca.key" -CAcreateserial \
  -out "$STAGE/package/credentials/server.crt" -extfile "$STAGE/server.ext" >/dev/null 2>&1
openssl rand -hex 32 | tr -d '\n' > "$STAGE/access/token.txt"
sha256sum "$STAGE/access/token.txt" | awk '{print $1}' > "$STAGE/package/credentials/token.sha256"
cp "$STAGE/ca.crt" "$STAGE/access/server.crt"
printf '%s\n' "$PORT" > "$STAGE/package/port"
cp "$PROJECT_ROOT/rust/packaging/README.txt" "$STAGE/package/README.txt"
node - "$STAGE/package" "$STAGE/access" "$ADDRESS" "$PORT" "$TARGET" "$(rustc --version)" "$ARCH" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, access, host, port, target, compiler, arch] = process.argv.slice(2);
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  status: 'prototype', version: '0.1.0', target, compiler, arch, port: Number(port),
  capabilities: ['exec', 'exec.stream', 'file.read', 'file.write', 'relay', 'upload', 'download'],
  notImplemented: ['deploy.ssh', 'supervisor', 'resumable-ssh-deploy']
}, null, 2) + '\n');
fs.writeFileSync(path.join(access, 'hosts.json'), JSON.stringify({ hosts: { 'rust-prototype': {
  host, port: Number(port), ca: '/ABSOLUTE/PATH/access/server.crt', tokenFile: '/ABSOLUTE/PATH/access/token.txt'
} } }, null, 2) + '\n');
NODE
chmod 0600 "$STAGE/package/credentials/"* "$STAGE/access/"*
# 不包含客户端 token 明文。RSA 私钥位于服务器包中，整个包须作为凭据保护。
tar -cf - -C "$STAGE/package" . | gzip -n -9 > "$STAGE/package.tar.gz"
BYTES="$(wc -c < "$STAGE/package.tar.gz")"
if ((BYTES >= LIMIT)); then
  printf '体积门禁失败：%s 字节，要求严格小于 %s 字节\n' "$BYTES" "$LIMIT" >&2
  exit 1
fi
mv "$STAGE/package.tar.gz" "$ARCHIVE"
mv "$STAGE/access" "$OUTPUT_DIR/access"
(cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
node - "$OUTPUT_DIR/size.json" "$BYTES" "$(wc -c < "$BINARY")" "$LIMIT" "$TARGET" "$ARCH" <<'NODE'
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({
  archiveBytes: Number(process.argv[3]), binaryBytes: Number(process.argv[4]),
  limitBytes: Number(process.argv[5]), credentialsIncluded: true, target: process.argv[6], arch: process.argv[7]
}, null, 2) + '\n');
NODE
printf '完整服务器包：%s\n大小：%s 字节（小于 %s）\n客户端资料：%s/access\n' "$ARCHIVE" "$BYTES" "$LIMIT" "$OUTPUT_DIR"
