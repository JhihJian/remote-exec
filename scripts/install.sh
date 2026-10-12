#!/usr/bin/env bash
# 函数全部定义完毕后才执行入口，支持 curl ... | bash。

fail() { printf '安装失败：%s\n' "$*" >&2; return 1; }

usage() {
  printf '%s\n' '用法：install.sh [--address DNS或IPv4] [--port 8791] [--run-user remote-exec|root] [--source HTTPS发布目录]'
}

cleanup() {
  if [[ -n "${work_dir:-}" ]]; then rm -rf -- "$work_dir"; fi
  if [[ -n "${app_stage:-}" ]]; then rm -rf -- "$app_stage"; fi
  if [[ -n "${credential_stage:-}" ]]; then rm -rf -- "$credential_stage"; fi
}

on_error() {
  local code="$1" line="$2"
  trap - ERR
  set +e
  if [[ "${started_service:-0}" == 1 && "${was_active:-0}" == 0 ]]; then
    systemctl disable --now remote-exec.service >/dev/null 2>&1
  fi
  printf '安装未完成（第 %s 行）。凭据已保留，可修复原因后重试。\n' "$line" >&2
  if [[ "${started_service:-0}" == 1 ]]; then
    printf '查看日志：journalctl -u remote-exec.service -n 30 --no-pager\n' >&2
    journalctl -u remote-exec.service -n 10 --no-pager >&2
  fi
  exit "$code"
}

validate_address() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && ${#1} -le 253 ]] || fail 'address 必须是 DNS 名或 IPv4 地址'
  if [[ "$1" =~ ^[0-9.]+$ ]]; then
    local a b c d extra octet
    IFS=. read -r a b c d extra <<< "$1"
    [[ -n "$a" && -n "$b" && -n "$c" && -n "$d" && -z "$extra" ]] || fail 'IPv4 地址无效'
    for octet in "$a" "$b" "$c" "$d"; do
      [[ "$octet" =~ ^[0-9]{1,3}$ && "$octet" == "$((10#$octet))" && "$((10#$octet))" -le 255 ]] || fail 'IPv4 地址无效'
    done
  else
    local label
    IFS=. read -ra labels <<< "$1"
    for label in "${labels[@]}"; do
      [[ ${#label} -le 63 && "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || fail 'DNS 名无效'
    done
  fi
}

preflight() {
  [[ "$EUID" == 0 ]] || fail '请以 root 执行，或使用 sudo bash'
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail '当前仅支持 Linux x86_64'
  local tool
  for tool in curl tar openssl sha256sum flock systemctl journalctl useradd getent install hostname awk sed chown chmod mktemp id cmp sort cp mv mkdir rm uname; do
    command -v "$tool" >/dev/null || fail "缺少基础工具：$tool"
  done
  [[ -f /etc/os-release ]] || fail '缺少 /etc/os-release'
  local ID VERSION_ID
  # 由操作系统管理的文件。
  . /etc/os-release
  case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) fail '仅支持 Ubuntu 22.04/24.04 和 Debian 12' ;; esac
  systemctl show --property=Version --value >/dev/null || fail 'systemd 管理器不可用'
  [[ "$run_user" == remote-exec || "$run_user" == root ]] || fail 'run-user 只能是 remote-exec 或 root'
  [[ "$port" =~ ^[0-9]{1,5}$ && "$port" != 0* ]] || fail 'port 必须是 1-65535 的整数'
  (( port >= 1 && port <= 65535 )) || fail 'port 必须是 1-65535 的整数'
  [[ "$source_url" == https://* && "$source_url" != *[[:space:]]* && "$source_url" != *\?* && "$source_url" != *\#* ]] || fail 'source 必须是 HTTPS 发布目录'
  if [[ -n "$address" ]]; then validate_address "$address"; fi
}

fetch() {
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 180 --retry 2 --output "$2" "$1"
}

read_setting() {
  /opt/remote-exec/runtime/bin/node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(typeof v!=="string"&&typeof v!=="number")process.exit(1);console.log(v)' /opt/remote-exec/install.json "$1"
}

smoke() {
  /opt/remote-exec/runtime/bin/node /opt/remote-exec/scripts/smoke.js \
    --port "$port" --ca /etc/remote-exec/credentials/server.crt \
    --token-file /root/remote-exec-access/token.txt --expected-user "$run_user"
}

summary() {
  printf '\nremote-exec %s 安装成功\n' "$version"
  printf '服务地址：https://%s:%s（监听 0.0.0.0）\n执行用户：%s\n' "$address" "$port" "$run_user"
  printf '开机自启：已启用\n客户端接入资料：/root/remote-exec-access.tar.gz\n'
  printf 'SSH 下载示例：scp root@%s:/root/remote-exec-access.tar.gz .\n' "$address"
  printf '解包后按 README.txt 配置客户端。请确认客户端到该端口的网络可达。\n'
  printf '查看日志：journalctl -u remote-exec.service -n 30 --no-pager\n'
  openssl x509 -in /etc/remote-exec/credentials/server.crt -noout -enddate -ext subjectAltName
}

prepare_credentials() {
  install -d -m 0711 -o root -g root /etc/remote-exec
  install -d -m 0700 -o root -g root /root/remote-exec-access
  if [[ ! -f /root/remote-exec-access/token.txt ]]; then
    [[ ! -d /etc/remote-exec/credentials ]] || fail '客户端 token 缺失，请从备份恢复，安装器不会自动轮换'
    printf '%s' "$(openssl rand -hex 32)" > "$work_dir/token.txt"
    install -m 0600 "$work_dir/token.txt" /root/remote-exec-access/token.txt
  fi
  if [[ ! -d /etc/remote-exec/credentials ]]; then
    credential_stage="$(mktemp -d /etc/remote-exec/.credentials.XXXXXX)"
    local hostname_value san ip
    hostname_value="$(hostname)"
    san='DNS:localhost,IP:127.0.0.1'
    if [[ "$hostname_value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then san+=",DNS:$hostname_value"; fi
    while IFS= read -r ip; do san+=",IP:$ip"; done < <(/opt/remote-exec/runtime/bin/node -e 'for(const list of Object.values(require("node:os").networkInterfaces()))for(const a of list)if(a.family==="IPv4"&&!a.internal)console.log(a.address)' | sort -u)
    if [[ "$address" =~ ^[0-9.]+$ ]]; then san+=",IP:$address"; else san+=",DNS:$address"; fi
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "$credential_stage/server.key" -out "$credential_stage/server.crt" \
      -subj '/CN=remote-exec' -addext "subjectAltName=$san" > /dev/null 2> "$work_dir/openssl.log"
    sha256sum /root/remote-exec-access/token.txt | awk '{print $1}' > "$credential_stage/token.sha256"
    chmod 0600 "$credential_stage"/*
    chown -R "$run_user:$run_group" "$credential_stage"
    mv "$credential_stage" /etc/remote-exec/credentials
    credential_stage=''
  fi
  local expected_hash actual_hash
  read -r expected_hash < /etc/remote-exec/credentials/token.sha256
  actual_hash="$(sha256sum /root/remote-exec-access/token.txt | awk '{print $1}')"
  [[ "$expected_hash" == "$actual_hash" ]] || fail 'token 与服务端哈希不一致，请恢复原凭据'
  openssl x509 -in /etc/remote-exec/credentials/server.crt -noout -checkend 0 >/dev/null || fail '证书已过期，请更新证书'
  cmp <(openssl x509 -in /etc/remote-exec/credentials/server.crt -pubkey -noout) <(openssl pkey -in /etc/remote-exec/credentials/server.key -pubout) >/dev/null || fail '证书与私钥不匹配'
  chown -R "$run_user:$run_group" /etc/remote-exec/credentials
  chmod 0700 /etc/remote-exec/credentials
  chmod 0600 /etc/remote-exec/credentials/*
}

write_access() {
  install -m 0600 /etc/remote-exec/credentials/server.crt /root/remote-exec-access/server.crt
  /opt/remote-exec/runtime/bin/node - "$address" "$port" <<'NODE'
const fs = require("node:fs");
const [host, port] = process.argv.slice(2);
const name = require("node:os").hostname();
const config = { hosts: { [name]: { host, port: Number(port), ca: "/ABSOLUTE/PATH/remote-exec-access/server.crt", tokenFile: "/ABSOLUTE/PATH/remote-exec-access/token.txt" } } };
fs.writeFileSync("/root/remote-exec-access/hosts.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
NODE
  printf '%s\n' '客户端接入：' '1. 解包到自己的凭据目录，并将目录权限设为 700、文件权限设为 600。' '2. 将 hosts.json 中 ca 和 tokenFile 改为解包文件的绝对路径。' '3. 将该 hosts 条目合并到 ~/.config/remote-exec/hosts.json，保留其他主机。' '4. 多个地址并存时，可从证书 SAN 中选择实际可达地址填写 host。' '5. 使用正常 TLS 验证连接，请勿关闭证书校验。' > /root/remote-exec-access/README.txt
  tar -czf "$work_dir/access.tar.gz" -C /root remote-exec-access
  install -m 0600 "$work_dir/access.tar.gz" /root/remote-exec-access.tar.gz
}

main() {
  set -Eeuo pipefail
  umask 077
  local address='' port=8791 run_user=remote-exec source_url='https://github.com/JhihJian/remote-exec/releases/latest/download'
  local address_set=0 port_set=0 user_set=0 source_set=0 work_dir='' app_stage='' credential_stage='' started_service=0 was_active=0
  local version run_group package_hash installed=0
  while (( $# )); do
    case "$1" in
      --help|-h) usage; return 0 ;;
      --address|--port|--run-user|--source)
        (( $# >= 2 )) || fail "$1 缺少参数"
        case "$1" in
          --address) address="$2"; address_set=1 ;;
          --port) port="$2"; port_set=1 ;;
          --run-user) run_user="$2"; user_set=1 ;;
          --source) source_url="${2%/}"; source_set=1 ;;
        esac
        shift 2 ;;
      *) fail "未知参数：$1" ;;
    esac
  done
  preflight
  # 固定安装路径由 root 管理。锁在首次系统写入前取得。
  exec 9>/run/lock/remote-exec-install.lock
  flock -n 9 || fail '另一个安装正在执行，请稍后重试'
  trap cleanup EXIT
  trap 'on_error "$?" "$LINENO"' ERR
  work_dir="$(mktemp -d)"
  if [[ -f /opt/remote-exec/install.json ]]; then
    [[ -x /opt/remote-exec/runtime/bin/node ]] || fail '既有安装的运行时缺失，请恢复运行包'
    installed=1
    local saved_port saved_user saved_address
    saved_port="$(read_setting port)"; saved_user="$(read_setting runUser)"; saved_address="$(read_setting address)"
    (( port_set == 0 )) || [[ "$port" == "$saved_port" ]] || fail '已有安装端口不同，安装命令不会改配置'
    (( user_set == 0 )) || [[ "$run_user" == "$saved_user" ]] || fail '已有安装执行身份不同，安装命令不会改配置'
    (( address_set == 0 )) || [[ "$address" == "$saved_address" ]] || fail '已有安装地址不同，安装命令不会轮换证书'
    port="$saved_port"; run_user="$saved_user"; address="$saved_address"
    preflight
  else
    [[ ! -e /opt/remote-exec && ! -e /etc/remote-exec && ! -e /root/remote-exec-access && ! -e /etc/systemd/system/remote-exec.service ]] || fail '发现既有部署，请使用对应升级或迁移流程'
    if systemctl cat remote-exec.service >/dev/null 2>&1; then fail '发现既有 remote-exec 服务，请使用对应升级或迁移流程'; fi
  fi
  if (( source_set == 0 )); then
    local release_version release_url
    if (( installed )); then
      release_version="$(read_setting version)"
    else
      release_url="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --output /dev/null --write-out '%{url_effective}' https://github.com/JhihJian/remote-exec/releases/latest)"
      release_version="${release_url##*/v}"
    fi
    [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '无法解析稳定发布版本'
    source_url="https://github.com/JhihJian/remote-exec/releases/download/v$release_version"
  fi
  printf '下载并校验运行包……\n'
  fetch "$source_url/remote-exec-linux-x64.tar.gz.sha256" "$work_dir/checksum"
  read -r package_hash _ < "$work_dir/checksum"
  [[ "$package_hash" =~ ^[0-9a-f]{64}$ ]] || fail '发布包校验文件无效'
  fetch "$source_url/remote-exec-linux-x64.tar.gz" "$work_dir/package.tar.gz"
  [[ "$(sha256sum "$work_dir/package.tar.gz" | awk '{print $1}')" == "$package_hash" ]] || fail '发布包 SHA-256 不匹配'
  tar -tzf "$work_dir/package.tar.gz" > "$work_dir/entries"
  awk 'BEGIN { ok=1 } /^\// || /(^|\/)\.\.($|\/)/ { ok=0 } END { exit !ok }' "$work_dir/entries" || fail '发布包包含非法路径'
  tar -tvzf "$work_dir/package.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { bad=1 } END { exit bad }' || fail '发布包包含链接或特殊文件'
  mkdir "$work_dir/package"
  tar -xzf "$work_dir/package.tar.gz" --no-same-owner --no-same-permissions -C "$work_dir/package"
  [[ -x "$work_dir/package/runtime/bin/node" ]] || fail '发布包缺少 Node 运行时'
  version="$("$work_dir/package/runtime/bin/node" - "$work_dir/package" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.platform !== "linux" || manifest.arch !== "x64" || manifest.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("发布包版本或平台无效");
if (manifest.nodeVersion.replace(/^v/, "") !== process.versions.node) throw new Error("Node 运行时与清单不一致");
for (const file of ["src/daemon/main.js", "scripts/smoke.js", "packaging/remote-exec.service"]) fs.accessSync(path.join(root, file));
require(path.join(root, "node_modules/ws"));
console.log(manifest.version);
NODE
)"
  if (( installed )); then
    [[ "$(read_setting version)" == "$version" ]] || fail '已安装其他版本，请使用独立升级流程'
    [[ "$(read_setting packageSha256)" == "$package_hash" ]] || fail '同版本发布包发生变化，请核查发布源'
  fi
  if [[ -z "$address" ]]; then
    address="$("$work_dir/package/runtime/bin/node" -e 'const addresses=Object.values(require("node:os").networkInterfaces()).flat().filter(a=>a.family==="IPv4"&&!a.internal);console.log(addresses[0]?.address||"127.0.0.1")')"
  fi
  validate_address "$address"
  if systemctl is-active --quiet remote-exec.service; then was_active=1; fi
  if (( was_active == 0 )); then
    "$work_dir/package/runtime/bin/node" - "$port" <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.once("error", (error) => { console.error(`端口不可用: ${error.message}`); process.exitCode = 1; });
server.listen(Number(process.argv[2]), "0.0.0.0", () => server.close());
NODE
  fi
  if [[ "$run_user" == remote-exec ]]; then
    if ! getent passwd remote-exec >/dev/null; then useradd --system --user-group --home-dir /var/lib/remote-exec --shell /usr/sbin/nologin remote-exec; fi
    [[ "$(id -u remote-exec)" != 0 ]] || fail 'remote-exec 用户不得具有 UID 0'
  fi
  run_group="$(id -gn "$run_user")"
  install -d -m 0755 -o "$run_user" -g "$run_group" /var/lib/remote-exec
  if (( installed == 0 )); then
    install -d -m 0755 -o root -g root /opt
    app_stage="$(mktemp -d /opt/.remote-exec.XXXXXX)"
    cp -a "$work_dir/package/." "$app_stage/"
    chown -R root:root "$app_stage"
    chmod -R a+rX "$app_stage"
    "$app_stage/runtime/bin/node" - "$app_stage" "$version" "$port" "$run_user" "$address" "$package_hash" <<'NODE'
const fs = require("node:fs");
const [root, version, port, runUser, address, packageSha256] = process.argv.slice(2);
fs.writeFileSync(`${root}/install.json`, JSON.stringify({ version, port: Number(port), runUser, address, packageSha256 }, null, 2) + "\n", { mode: 0o600 });
NODE
    mv "$app_stage" /opt/remote-exec
    app_stage=''
  fi
  prepare_credentials
  if (( was_active == 0 )); then
    local capabilities=''
    if (( port < 1024 )) && [[ "$run_user" != root ]]; then capabilities='AmbientCapabilities=CAP_NET_BIND_SERVICE'; fi
    sed -e "s/@USER@/$run_user/g" -e "s/@GROUP@/$run_group/g" -e "s/@PORT@/$port/g" -e "s/@CAPABILITIES@/$capabilities/g" \
      /opt/remote-exec/packaging/remote-exec.service > "$work_dir/remote-exec.service"
    install -m 0644 "$work_dir/remote-exec.service" /etc/systemd/system/remote-exec.service
    systemctl daemon-reload
    started_service=1
    systemctl enable --now remote-exec.service
  else
    systemctl enable remote-exec.service
  fi
  local attempt
  for attempt in {1..15}; do
    if smoke > "$work_dir/smoke.log" 2>&1; then break; fi
    if (( attempt == 15 )); then cat "$work_dir/smoke.log" >&2; fail 'TLS/WSS 命令验收失败'; fi
    sleep 1
  done
  systemctl is-active --quiet remote-exec.service
  systemctl is-enabled --quiet remote-exec.service
  write_access
  summary
  cleanup
  trap - EXIT
}

# 请保持入口调用位于文件末尾。
main "$@"
