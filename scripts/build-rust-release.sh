#!/usr/bin/env bash
# remote-exec（Rust）正式构建与发布打包：
#   - daemon（remote-execd）双架构 musl 静态包 remote-exec-linux-{x64,arm64}.tar.gz
#   - 体积门禁：daemon 压缩包严格小于 2,000,000 字节
#   - rex 客户端双架构包 rex-linux-{x64,arm64}.tar.gz（独立体积预算，无门禁）
#   - 产物附 SHA-256 与 size.json 汇总
#
# x86_64 本机交叉（musl-gcc），aarch64 经 docker messense/rust-musl-cross 交叉。
# 交叉环境已产出二进制时可用 --skip-build 仅校验打包。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/dist/rust-release"
ARCHES=(x64 arm64)
SKIP_BUILD=0
VERSION=''
LIMIT=2000000

usage() {
  printf '%s\n' '用法：build-rust-release.sh [--arch x64|arm64|all] [--output-dir DIR] [--version X.Y.Z] [--skip-build]'
}

while (($#)); do
  case "$1" in
    --arch)
      (($# >= 2)) || { printf '%s 需要参数\n' "$1" >&2; exit 2; }
      case "$2" in
        x64) ARCHES=(x64) ;;
        arm64) ARCHES=(arm64) ;;
        all) ARCHES=(x64 arm64) ;;
        *) printf '不支持的架构：%s（x64/arm64/all）\n' "$2" >&2; exit 2 ;;
      esac
      shift 2 ;;
    --output-dir)
      (($# >= 2)) || { printf '%s 需要参数\n' "$1" >&2; exit 2; }
      OUTPUT_DIR="$2"; shift 2 ;;
    --version)
      (($# >= 2)) || { printf '%s 需要参数\n' "$1" >&2; exit 2; }
      VERSION="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

[[ -f "$PROJECT_ROOT/rust/packaging/install.sh" ]] || { printf '缺少 rust/packaging/install.sh\n' >&2; exit 1; }
for tool in cargo rustc node tar gzip sha256sum readelf awk; do
  command -v "$tool" >/dev/null || { printf '构建端缺少：%s\n' "$tool" >&2; exit 1; }
done
if [[ -z "$VERSION" ]]; then
  VERSION="$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version")"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '版本号无效：%s\n' "$VERSION" >&2; exit 2; }
COMPILER="$(rustc --version)"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

target_of() { case "$1" in x64) echo x86_64-unknown-linux-musl ;; arm64) echo aarch64-unknown-linux-musl ;; esac; }
machine_of() { case "$1" in x64) echo 'Advanced Micro Devices X86-64' ;; arm64) echo 'AArch64' ;; esac; }

# ---- 构建 ----
build_local_x64() {
  command -v musl-gcc >/dev/null || { printf '缺少 musl-gcc（x64 本机交叉需要）\n' >&2; exit 1; }
  export CC_x86_64_unknown_linux_musl=musl-gcc
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
  (cd "$PROJECT_ROOT/rust" && cargo build --release --locked \
    --target x86_64-unknown-linux-musl -p remote-exec-daemon -p remote-exec-rex -p remote-exec-ops)
}

build_docker_arm64() {
  command -v docker >/dev/null || { printf '缺少 docker（arm64 交叉经 messense/rust-musl-cross）\n' >&2; exit 1; }
  docker run --rm \
    -v "$PROJECT_ROOT/rust:/home/rust/src" \
    -v remote-exec-cargo-registry:/home/rust/.cargo/registry \
    messense/rust-musl-cross:aarch64-musl \
    cargo build --release --locked --target aarch64-unknown-linux-musl \
      -p remote-exec-daemon -p remote-exec-rex -p remote-exec-ops
}

# ---- 第三方许可证 ----
third_party() { # $1: crate 名（remote-exec-daemon|remote-exec-rex） $2: target $3: 输出文件
  cargo metadata --offline --locked --format-version 1 --filter-platform "$2" \
    --manifest-path "$PROJECT_ROOT/rust/${1#remote-exec-}/Cargo.toml" > "$WORK/metadata.json"
  node - "$WORK/metadata.json" "$3" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sections = [];
for (const pkg of metadata.packages.filter(p => p.source).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.dirname(pkg.manifest_path);
  const files = fs.readdirSync(dir).filter(name => /^(LICENSE|COPYING|NOTICE)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
  // 无许可证文件的依赖记录声明值（Cargo.toml license 字段），不中断构建。
  if (!files.length) {
    sections.push(`${pkg.name} ${pkg.version} (${pkg.license || '未声明'})\n上游包未附带许可证文件，声明见上。`);
    continue;
  }
  sections.push(`${pkg.name} ${pkg.version} (${pkg.license || '见许可证'})\n` +
    files.map(name => `${name}\n${fs.readFileSync(path.join(dir, name), 'utf8')}`).join('\n'));
}
fs.writeFileSync(process.argv[3], sections.join('\n\n') + '\n');
NODE
}

package_binary() { # $1: arch $2: target $3: 二进制名 $4: 包名
  local binary="$PROJECT_ROOT/rust/target/$2/release/$3"
  [[ -f "$binary" ]] || { printf '二进制不存在：%s\n' "$binary" >&2; exit 1; }
  # musl 静态校验：不得有动态解释器或动态库依赖。
  if readelf -l "$binary" | grep -q 'INTERP' || readelf -d "$binary" 2>/dev/null | grep -q 'NEEDED'; then
    printf '构建产物包含动态解释器或动态库依赖：%s\n' "$binary" >&2; exit 1
  fi
  readelf -h "$binary" | grep -q "Machine:.*$(machine_of "$1")" \
    || { printf '二进制架构与 %s 不匹配\n' "$2" >&2; exit 1; }

  local stage="$WORK/$4"
  mkdir -p "$stage/bin" "$stage/scripts" "$stage/packaging"
  install -m 0755 "$binary" "$stage/bin/$3"
  install -m 0644 "$PROJECT_ROOT/LICENSE" "$stage/LICENSE"
  local package_name
  case "$3" in
    remote-execd) package_name=daemon ;;
    rex) package_name=rex ;;
    rex-ops) package_name=ops ;;
    *) printf '未知 Rust 产物：%s\n' "$3" >&2; exit 1 ;;
  esac
  third_party "remote-exec-$package_name" "$2" "$stage/THIRD_PARTY_LICENSES.txt"

  local archive_bytes
  if [[ "$3" == rex || "$3" == rex-ops ]]; then
    local component
    component=$([[ "$3" == rex-ops ]] && echo 'rex-ops' || echo 'rex')
    node - "$stage/manifest.json" "$VERSION" "$2" "$1" "$COMPILER" "$component" <<'NODE'
const fs = require('node:fs');
const [out, version, target, arch, compiler, component] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({ status: 'release', component, version, target, arch, compiler }, null, 2) + '\n');
NODE
    archive_bytes="$(tar_and_hash "$stage" "$OUTPUT_DIR/$4.tar.gz")"
    printf 'rex 客户端包：%s（%s 字节，无体积门禁）\n' "$OUTPUT_DIR/$4.tar.gz" "$archive_bytes" >&2
  else
    install -m 0755 "$PROJECT_ROOT/rust/packaging/install.sh" "$stage/scripts/install.sh"
    install -m 0644 "$PROJECT_ROOT/rust/packaging/remote-exec-supervisor.service" "$stage/packaging/remote-exec-supervisor.service"
    node - "$stage/manifest.json" "$VERSION" "$2" "$1" "$COMPILER" <<'NODE'
const fs = require('node:fs');
const [out, version, target, arch, compiler] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  status: 'release', component: 'daemon', version, target, arch, compiler,
  layout: { binary: 'bin/remote-execd', installer: 'scripts/install.sh', unit: 'packaging/remote-exec-supervisor.service' },
  capabilities: ['exec', 'exec.stream', 'file.read', 'file.write', 'relay', 'upload', 'download', 'supervisor'],
  extensions: ['rex-ops'],
}, null, 2) + '\n');
NODE
    archive_bytes="$(tar_and_hash "$stage" "$OUTPUT_DIR/$4.tar.gz")"
    if ((archive_bytes >= LIMIT)); then
      printf '体积门禁失败：%s 字节，要求严格小于 %s 字节\n' "$archive_bytes" "$LIMIT" >&2
      exit 1
    fi
    printf 'daemon 服务包：%s（%s 字节 < %s）\n' "$OUTPUT_DIR/$4.tar.gz" "$archive_bytes" "$LIMIT" >&2
  fi
  printf '%s %s\n' "$archive_bytes" "$binary"
}

tar_and_hash() { # $1: stage 目录 $2: 输出 tar.gz —— 输出字节数
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -cf - -C "$1" . | gzip -n -9 > "$2"
  (cd "$(dirname "$2")" && sha256sum "$(basename "$2")" > "$(basename "$2").sha256")
  wc -c < "$2"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RESULTS=()
for arch in "${ARCHES[@]}"; do
  target="$(target_of "$arch")"
  if (( ! SKIP_BUILD )); then
    case "$arch" in
      x64) build_local_x64 ;;
      arm64) build_docker_arm64 ;;
    esac
  fi
  while read -r bytes binary; do RESULTS+=("$(printf '%s %s %s %s' "$arch" "$bytes" "$(basename "$binary")" "$(wc -c < "$binary")")"); done < <(package_binary "$arch" "$target" remote-execd "remote-exec-linux-$arch")
  while read -r bytes binary; do RESULTS+=("$(printf '%s %s %s %s' "$arch" "$bytes" "$(basename "$binary")" "$(wc -c < "$binary")")"); done < <(package_binary "$arch" "$target" rex "rex-linux-$arch")
  while read -r bytes binary; do RESULTS+=("$(printf '%s %s %s %s' "$arch" "$bytes" "$(basename "$binary")" "$(wc -c < "$binary")")"); done < <(package_binary "$arch" "$target" rex-ops "rex-ops-linux-$arch")
done

node - "$OUTPUT_DIR/size.json" "$VERSION" "$LIMIT" "${RESULTS[@]}" <<'NODE'
const fs = require('node:fs');
const [out, version, limit, ...results] = process.argv.slice(2);
const incoming = results.map(line => {
  const [arch, archiveBytes, archive, binaryBytes] = line.split(' ');
  const component = archive.startsWith('remote-exec-linux') ? 'daemon' :
    (archive.startsWith('rex-ops') ? 'rex-ops' : 'rex');
  return {
    component, arch, archive, archiveBytes: Number(archiveBytes), binaryBytes: Number(binaryBytes),
    sizeGatePassed: component !== 'daemon' || Number(archiveBytes) < Number(limit),
  };
});
// 单架构运行只刷新该架构条目，保留其他架构的历史记录。
const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { artifacts: [] };
const artifacts = incoming.concat(previous.artifacts.filter(
  old => !incoming.some(fresh => fresh.component === old.component && fresh.arch === old.arch)
));
fs.writeFileSync(out, JSON.stringify({ version, limitBytes: Number(limit), artifacts }, null, 2) + '\n');
NODE
printf '\n版本 %s：产物与 size.json 已写入 %s\n' "$VERSION" "$OUTPUT_DIR"
