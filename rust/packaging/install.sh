#!/usr/bin/env bash
# remote-exec（Rust）正式安装器：安装 supervisor 布局并完成 TLS/WSS 验收。
# 函数全部定义完毕后才执行入口，支持 curl ... | bash。
#
# 布局：/opt/remote-exec/versions/<id> + current 链接 +
#       /etc/remote-exec/credentials/{ca.crt,server.crt,server.key,token.sha256} +
#       /etc/remote-exec/supervisor-state.json +
#       /etc/systemd/system/remote-exec-supervisor.service。
# 既有 Node 安装（/opt/remote-exec/install.json）请使用 rex-ops migrate 迁移流程。

fail() { printf '安装失败：%s\n' "$*" >&2; return 1; }

usage() {
  printf '%s\n' '用法：install.sh [--address DNS或IPv4] [--port 8791] [--run-user remote-exec|root] [--source HTTPS发布目录] [--package 本地归档路径]'
}

cleanup() {
  if [[ -n "${work_dir:-}" ]]; then rm -rf -- "$work_dir"; fi
  if [[ -n "${versions_stage:-}" ]]; then rm -rf -- "$versions_stage"; fi
  if [[ -n "${credential_stage:-}" ]]; then rm -rf -- "$credential_stage"; fi
}

on_error() {
  local code="$1" line="$2"
  trap - ERR
  set +e
  if [[ "${started_service:-0}" == 1 && "${was_active:-0}" == 0 ]]; then
    systemctl disable --now remote-exec-supervisor.service >/dev/null 2>&1
  fi
  printf '安装未完成（第 %s 行）。凭据已保留，可修复原因后重试。\n' "$line" >&2
  if [[ "${started_service:-0}" == 1 ]]; then
    printf '查看日志：journalctl -u remote-exec-supervisor.service -n 30 --no-pager\n' >&2
    journalctl -u remote-exec-supervisor.service -n 10 --no-pager >&2
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
  [[ "$(uname -s)" == Linux ]] || fail '仅支持 Linux'
  case "$(uname -m)" in
    x86_64) machine=x86_64 ;;
    aarch64|arm64) machine=aarch64 ;;
    *) fail "不支持的架构：$(uname -m)" ;;
  esac
  local tool
  for tool in curl tar openssl sha256sum flock systemctl journalctl useradd getent install hostname awk sed chown chmod mktemp id cmp sort cp mv mkdir rm uname realpath bash; do
    command -v "$tool" >/dev/null || fail "缺少基础工具：$tool"
  done
  [[ -f /etc/os-release ]] || fail '缺少 /etc/os-release'
  local ID VERSION_ID
  # 由操作系统管理的文件。
  . /etc/os-release
  case "$ID:$VERSION_ID:$machine" in
    ubuntu:22.04:x86_64|ubuntu:22.04:aarch64|ubuntu:24.04:x86_64|ubuntu:24.04:aarch64|debian:12:x86_64|debian:12:aarch64|openEuler:22.03:aarch64) ;;
    *) fail "未验证的操作系统矩阵：$ID $VERSION_ID $machine（已验证：Ubuntu 22.04/24.04、Debian 12 双架构，openEuler 22.03 aarch64）" ;;
  esac
  systemctl show --property=Version --value >/dev/null || fail 'systemd 管理器不可用'
  [[ "$run_user" == remote-exec || "$run_user" == root ]] || fail 'run-user 只能是 remote-exec 或 root'
  [[ "$port" =~ ^[0-9]{1,5}$ && "$port" != 0* ]] || fail 'port 必须是 1-65535 的整数'
  (( port >= 1 && port <= 65535 )) || fail 'port 必须是 1-65535 的整数'
  if [[ -n "${package_path:-}" ]]; then
    package_path="$(realpath -e -- "$package_path")" || fail 'package 文件不存在'
    [[ -f "$package_path" ]] || fail 'package 必须是普通文件'
    [[ -f "$package_path.sha256" ]] || fail 'package 缺少相邻的 SHA-256 校验文件'
  else
    [[ "$source_url" == https://* && "$source_url" != *[[:space:]]* && "$source_url" != *\?* && "$source_url" != *\#* ]] || fail 'source 必须是 HTTPS 发布目录'
  fi
  if [[ -n "$address" ]]; then validate_address "$address"; fi
}

fetch() {
  local attempt code
  for attempt in 1 2 3; do
    if curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 900 --speed-limit 1024 --speed-time 60 --continue-at - --output "$2" "$1"; then
      return 0
    else
      code=$?
    fi
    # HTTP 错误与不支持续传应直接报告，网络中断则保留已下载内容。
    if [[ "$code" == 22 || "$code" == 33 ]]; then return "$code"; fi
    printf '下载中断，保留进度后重试（%s/3）……\n' "$attempt" >&2
  done
  return "$code"
}

read_release_setting() {
  # release.json 每行一个键；值可能带引号（字符串）或不带（数字）。
  sed -n "s/^.*\"$1\": \"\{0,1\}\([^\",}\]*\).*/\1/p" /opt/remote-exec/release.json
}

smoke() {
  # 真实 TLS + Bearer 握手验收：有效 token 必须 101，无效 token 必须 401。
  # websocket 连接在 101 后保持打开，curl 会以超时退出，只断言状态码。
  local token="$1" code bad
  code="$(curl --http1.1 --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --cacert /etc/remote-exec/credentials/ca.crt \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H "Authorization: Bearer $token" \
    "https://127.0.0.1:$port/" || true)"
  [[ "$code" == 101 ]] || { printf 'WSS 握手验收返回 %s（期望 101）\n' "$code" >&2; return 1; }
  bad="$(curl --http1.1 --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --cacert /etc/remote-exec/credentials/ca.crt \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Authorization: Bearer invalid-token' \
    "https://127.0.0.1:$port/" || true)"
  [[ "$bad" == 401 ]] || { printf '无效 token 未被拒绝（返回 %s，期望 401）\n' "$bad" >&2; return 1; }
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
    # 首次安装生成 CA + 叶子证书：客户端按 CA 验证，supervisor 按 CA 验证 backend。
    credential_stage="$(mktemp -d /etc/remote-exec/.credentials.XXXXXX)"
    local hostname_value san ip
    hostname_value="$(hostname)"
    san='DNS:localhost,IP:127.0.0.1'
    if [[ "$hostname_value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then san+=",DNS:$hostname_value"; fi
    if [[ "$address" =~ ^[0-9.]+$ ]]; then san+=",IP:$address"; else san+=",DNS:$address"; fi
    while IFS= read -r ip; do san+=",IP:$ip"; done < <(printf '%s\n' "$(hostname -I 2>/dev/null)" | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u)
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$credential_stage/ca.key" -out "$credential_stage/ca.crt" \
      -subj '/CN=remote-exec-local-ca' \
      -addext 'basicConstraints=critical,CA:TRUE' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' > /dev/null 2> "$work_dir/openssl.log"
    openssl req -new -newkey rsa:2048 -nodes \
      -keyout "$credential_stage/server.key" -out "$work_dir/server.csr" \
      -subj '/CN=remote-exec' > /dev/null 2>> "$work_dir/openssl.log"
    printf 'subjectAltName=%s\n' "$san" > "$work_dir/server.ext"
    openssl x509 -req -days 825 -in "$work_dir/server.csr" \
      -CA "$credential_stage/ca.crt" -CAkey "$credential_stage/ca.key" -CAcreateserial \
      -out "$credential_stage/server.crt" -extfile "$work_dir/server.ext" > /dev/null 2>> "$work_dir/openssl.log"
    sha256sum /root/remote-exec-access/token.txt | awk '{print $1}' > "$credential_stage/token.sha256"
    # CA 私钥只用于签发叶子，签发完成后立即销毁，不留在目标机。
    rm -f "$credential_stage/ca.key" "$credential_stage/ca.srl"
    chmod 0600 "$credential_stage"/*
    chown -R "$run_user:$run_group" "$credential_stage"
    mv "$credential_stage" /etc/remote-exec/credentials
    credential_stage=''
  fi
  # 既有凭据校验：不轮换、不重签。
  [[ -f /etc/remote-exec/credentials/ca.crt ]] || fail '凭据缺少 ca.crt（Node 布局凭据请使用迁移流程）'
  local expected_hash actual_hash
  read -r expected_hash < /etc/remote-exec/credentials/token.sha256
  actual_hash="$(sha256sum /root/remote-exec-access/token.txt | awk '{print $1}')"
  [[ "$expected_hash" == "$actual_hash" ]] || fail 'token 与服务端哈希不一致，请恢复原凭据'
  openssl x509 -in /etc/remote-exec/credentials/server.crt -noout -checkend 0 >/dev/null || fail '证书已过期，请更新证书'
  cmp <(openssl x509 -in /etc/remote-exec/credentials/server.crt -pubkey -noout) <(openssl pkey -in /etc/remote-exec/credentials/server.key -pubout) >/dev/null || fail '证书与私钥不匹配'
  openssl verify -CAfile /etc/remote-exec/credentials/ca.crt /etc/remote-exec/credentials/server.crt >/dev/null 2>&1 || fail '叶子证书与 CA 不匹配'
  chown -R "$run_user:$run_group" /etc/remote-exec/credentials
  chmod 0700 /etc/remote-exec/credentials
  chmod 0600 /etc/remote-exec/credentials/*
}

write_access() {
  install -m 0600 /etc/remote-exec/credentials/ca.crt /root/remote-exec-access/ca.crt
  install -m 0600 /etc/remote-exec/credentials/server.crt /root/remote-exec-access/server.crt
  write_access_hosts
  printf '%s\n' '客户端接入：' '1. 解包到自己的凭据目录，并将目录权限设为 700、文件权限设为 600。' '2. 将 hosts.json 中 ca 和 tokenFile 改为解包文件的绝对路径。' '3. 将该 hosts 条目合并到 ~/.config/remote-exec/hosts.json，保留其他主机。' '4. 多个地址并存时，可从证书 SAN 中选择实际可达地址填写 host。' '5. 使用正常 TLS 验证连接，请勿关闭证书校验。' > /root/remote-exec-access/README.txt
  tar -czf "$work_dir/access.tar.gz" -C /root remote-exec-access
  install -m 0600 "$work_dir/access.tar.gz" /root/remote-exec-access.tar.gz
}

write_access_hosts() {
  local name
  name="$(hostname)"
  printf '{\n  "hosts": {\n    "%s": {\n      "host": "%s",\n      "port": %s,\n      "ca": "/ABSOLUTE/PATH/remote-exec-access/ca.crt",\n      "tokenFile": "/ABSOLUTE/PATH/remote-exec-access/token.txt"\n    }\n  }\n}\n' \
    "$name" "$address" "$port" > /root/remote-exec-access/hosts.json
  chmod 0600 /root/remote-exec-access/hosts.json
}

summary() {
  printf '\nremote-exec %s 安装成功（Rust）\n' "$version"
  printf '服务地址：https://%s:%s（监听 0.0.0.0，supervisor）\n执行用户：%s\n' "$address" "$port" "$run_user"
  printf '开机自启：已启用\n客户端接入资料：/root/remote-exec-access.tar.gz\n'
  printf 'SSH 下载示例：scp root@%s:/root/remote-exec-access.tar.gz .\n' "$address"
  printf '升级：rex-ops upgrade（SSH root 通道，零中断）；回滚：rex-ops upgrade --rollback\n'
  printf '查看日志：journalctl -u remote-exec-supervisor.service -n 30 --no-pager\n'
  openssl x509 -in /etc/remote-exec/credentials/server.crt -noout -enddate -ext subjectAltName
}

main() {
  set -Eeuo pipefail
  umask 077
  local address='' port=8791 run_user=remote-exec source_url='https://github.com/JhihJian/remote-exec/releases/latest/download' package_path=''
  local address_set=0 port_set=0 user_set=0 source_set=0 package_set=0 work_dir='' versions_stage='' credential_stage='' started_service=0 was_active=0
  local version machine package_hash installed=0 run_group
  while (( $# )); do
    case "$1" in
      --help|-h) usage; return 0 ;;
      --address|--port|--run-user|--source|--package)
        (( $# >= 2 )) || fail "$1 缺少参数"
        case "$1" in
          --address) address="$2"; address_set=1 ;;
          --port) port="$2"; port_set=1 ;;
          --run-user) run_user="$2"; user_set=1 ;;
          --source) source_url="${2%/}"; source_set=1 ;;
          --package) package_path="$2"; package_set=1 ;;
        esac
        shift 2 ;;
      *) fail "未知参数：$1" ;;
    esac
  done
  (( source_set == 0 || package_set == 0 )) || fail '--package 与显式 --source 互斥'
  if (( package_set )); then [[ -n "$package_path" ]] || fail '--package 路径不能为空'; fi
  preflight
  # 固定安装路径由 root 管理。锁在首次系统写入前取得。
  exec 9>/run/lock/remote-exec-install.lock
  flock -n 9 || fail '另一个安装正在执行，请稍后重试'
  trap cleanup EXIT
  trap 'on_error "$?" "$LINENO"' ERR
  work_dir="$(mktemp -d)"
  if [[ -f /opt/remote-exec/install.json ]]; then
    fail '检测到既有 Node 安装（/opt/remote-exec/install.json），请使用 rex-ops migrate 迁移流程'
  fi
  if [[ -d /opt/remote-exec/versions ]]; then
    [[ -f /opt/remote-exec/release.json ]] || fail '已是 Rust 布局但缺少 release.json（可能是 rex-ops migrate 迁移布局）；升级请使用 rex-ops upgrade'
    installed=1
    local saved_port saved_user saved_address saved_version saved_hash
    saved_port="$(read_release_setting port)"; saved_user="$(read_release_setting runUser)"; saved_address="$(read_release_setting address)"
    saved_version="$(read_release_setting version)"; saved_hash="$(read_release_setting packageSha256)"
    (( port_set == 0 )) || [[ "$port" == "$saved_port" ]] || fail '已有安装端口不同，安装命令不会改配置'
    (( user_set == 0 )) || [[ "$run_user" == "$saved_user" ]] || fail '已有安装执行身份不同，安装命令不会改配置'
    (( address_set == 0 )) || [[ "$address" == "$saved_address" ]] || fail '已有安装地址不同，安装命令不会轮换证书'
    port="$saved_port"; run_user="$saved_user"; address="$saved_address"
    preflight
  else
    [[ ! -e /opt/remote-exec && ! -e /etc/remote-exec && ! -e /root/remote-exec-access && ! -e /etc/systemd/system/remote-exec-supervisor.service ]] || fail '发现既有部署，请使用对应升级或迁移流程'
    if systemctl cat remote-exec.service >/dev/null 2>&1; then fail '发现既有 remote-exec 服务，请使用对应升级或迁移流程'; fi
  fi
  if (( package_set == 0 )); then printf '下载并校验运行包……\n'; else printf '复制并校验本地运行包……\n'; fi
  if (( package_set )); then
    cp -- "$package_path" "$work_dir/package.tar.gz"
    read -r package_hash _ < "$package_path.sha256" || fail 'package SHA-256 校验文件为空'
  else
    local archive
    case "$machine" in
      x86_64) archive=remote-exec-linux-x64.tar.gz ;;
      aarch64) archive=remote-exec-linux-arm64.tar.gz ;;
    esac
    fetch "$source_url/$archive.sha256" "$work_dir/checksum"
    read -r package_hash _ < "$work_dir/checksum"
    [[ "$package_hash" =~ ^[0-9a-f]{64}$ ]] || fail '发布包校验文件无效'
    fetch "$source_url/$archive" "$work_dir/package.tar.gz"
  fi
  [[ "$package_hash" =~ ^[0-9a-f]{64}$ ]] || fail '发布包校验文件无效'
  [[ "$(sha256sum "$work_dir/package.tar.gz" | awk '{print $1}')" == "$package_hash" ]] || fail '发布包 SHA-256 不匹配'
  tar -tzf "$work_dir/package.tar.gz" > "$work_dir/entries"
  awk 'BEGIN { ok=1 } /^\// || /(^|\/)\.\.($|\/)/ { ok=0 } END { exit !ok }' "$work_dir/entries" || fail '发布包包含非法路径'
  tar -tvzf "$work_dir/package.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { bad=1 } END { exit bad }' || fail '发布包包含链接或特殊文件'
  mkdir "$work_dir/package"
  tar -xzf "$work_dir/package.tar.gz" --no-same-owner --no-same-permissions -C "$work_dir/package"
  [[ -x "$work_dir/package/bin/remote-execd" ]] || fail '发布包缺少 bin/remote-execd'
  [[ -f "$work_dir/package/scripts/install.sh" ]] || fail '发布包缺少 scripts/install.sh'
  [[ -f "$work_dir/package/packaging/remote-exec-supervisor.service" ]] || fail '发布包缺少 supervisor 单元'
  read -r package_target package_version _ < <(awk 'BEGIN { FS="\"" } /target/ { t=$4 } /version/ { v=$4 } END { print t, v }' "$work_dir/package/manifest.json")
  [[ "$package_target" == x86_64-unknown-linux-musl || "$package_target" == aarch64-unknown-linux-musl ]] || fail '发布包 target 无效'
  [[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '发布包版本无效'
  case "$package_target:$machine" in
    x86_64-unknown-linux-musl:x86_64|aarch64-unknown-linux-musl:aarch64) ;;
    *) fail "发布包架构（$package_target）与本机（$machine）不匹配" ;;
  esac
  version="$package_version"
  "$work_dir/package/bin/remote-execd" --help >/dev/null 2>&1 || fail '发布包二进制无法在本机执行'
  if (( installed )); then
    [[ "$(read_release_setting version)" == "$version" ]] || fail "已安装其他版本（$(read_release_setting version)），请使用 rex-ops upgrade"
    [[ "$(read_release_setting packageSha256)" == "$package_hash" ]] || fail '同版本发布包发生变化，请核查发布源'
  fi
  if [[ -z "$address" ]]; then
    address="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1 || true)"
    address="${address:-127.0.0.1}"
  fi
  validate_address "$address"
  if systemctl is-active --quiet remote-exec-supervisor.service; then was_active=1; fi
  if (( was_active == 0 )); then
    if timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
      exec 3>&- 3<&- || true
      fail "端口 $port 已被占用"
    fi
  fi
  if [[ "$run_user" == remote-exec ]]; then
    if ! getent passwd remote-exec >/dev/null; then useradd --system --user-group --home-dir /var/lib/remote-exec --shell /usr/sbin/nologin remote-exec; fi
    [[ "$(id -u remote-exec)" != 0 ]] || fail 'remote-exec 用户不得具有 UID 0'
  fi
  run_group="$(id -gn "$run_user")"
  install -d -m 0755 -o "$run_user" -g "$run_group" /var/lib/remote-exec
  prepare_credentials
  if (( installed == 0 )); then
    # 首装引导：解包 bootstrap generation 使 ctl 二进制可用，正式 generation
    # 统一由 ctl upgrade 创建（与 rex-ops upgrade 首装路径一致）。
    install -d -m 0755 -o root -g root /opt
    local generation
    generation="bootstrap-$(date +%s)-${package_hash:0:8}"
    versions_stage="/opt/remote-exec/versions/$generation"
    install -d -m 0755 -o root -g root "$versions_stage"
    cp -a "$work_dir/package/." "$versions_stage/"
    chmod -R a+rX,go-w "$versions_stage"
    ln -sfn "$versions_stage" /opt/remote-exec/current
    versions_stage=''
    # release.json 尽早落盘：首装中途失败后重跑时能识别同版本重装。
    printf '{\n  "version": "%s",\n  "packageSha256": "%s",\n  "port": %s,\n  "runUser": "%s",\n  "address": "%s"\n}\n' \
      "$version" "$package_hash" "$port" "$run_user" "$address" > "$work_dir/release.json"
    install -m 0644 -o root -g root "$work_dir/release.json" /opt/remote-exec/release.json
  fi
  if (( was_active == 0 )); then
    sed -e "s/@PORT@/$port/g" -e "s/@RUN_USER@/$run_user/g" \
      "$work_dir/package/packaging/remote-exec-supervisor.service" > "$work_dir/remote-exec-supervisor.service"
    install -m 0644 "$work_dir/remote-exec-supervisor.service" /etc/systemd/system/remote-exec-supervisor.service
    systemctl daemon-reload
    started_service=1
    systemctl enable --now remote-exec-supervisor.service
  else
    systemctl enable remote-exec-supervisor.service
  fi
  # supervisor 控制套接字就绪后创建正式 generation；重装且已有 active 时跳过。
  local attempt socket_ready=0
  for attempt in {1..15}; do
    if [[ -S /run/remote-exec/supervisor.sock ]]; then socket_ready=1; break; fi
    sleep 1
  done
  (( socket_ready == 1 )) || fail 'supervisor 控制套接字未就绪'
  local ctl_status active_missing=0
  if ! ctl_status="$(/opt/remote-exec/current/bin/remote-execd ctl --control /run/remote-exec/supervisor.sock status)"; then
    fail 'ctl status 查询失败'
  fi
  grep -q '"active": *null' <<<"$ctl_status" && active_missing=1
  if (( active_missing == 1 )); then
    # command 为数组语义：每个 token 单独传给 ctl，不得整串引号包裹。
    /opt/remote-exec/current/bin/remote-execd ctl --control /run/remote-exec/supervisor.sock upgrade \
      --package "$work_dir/package.tar.gz" --sha256 "$package_hash" \
      --versions-dir /opt/remote-exec/versions --link /opt/remote-exec/current \
      --backend-protocol https --backend-ca /etc/remote-exec/credentials/ca.crt \
      --cwd /var/lib/remote-exec \
      -- '{version_dir}/bin/remote-execd' daemon --cert /etc/remote-exec/credentials/server.crt --key /etc/remote-exec/credentials/server.key --token-sha256-file /etc/remote-exec/credentials/token.sha256 \
      > "$work_dir/ctl-upgrade.log" 2>&1 || { cat "$work_dir/ctl-upgrade.log" >&2; fail 'ctl upgrade 首装失败'; }
  fi
  local token
  token="$(cat /root/remote-exec-access/token.txt)"
  for attempt in {1..15}; do
    if smoke "$token" > "$work_dir/smoke.log" 2>&1; then break; fi
    if (( attempt == 15 )); then cat "$work_dir/smoke.log" >&2; fail 'TLS/WSS 命令验收失败'; fi
    sleep 1
  done
  systemctl is-active --quiet remote-exec-supervisor.service
  systemctl is-enabled --quiet remote-exec-supervisor.service
  write_access
  summary
  cleanup
  trap - EXIT
}

# 请保持入口调用位于文件末尾。
main "$@"
