#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const projectRoot = path.resolve(__dirname, "../..");
const installScript = path.join(projectRoot, "scripts/install.sh");
const packageVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败 (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function makeCertificate(root) {
  const key = path.join(root, "source.key");
  const cert = path.join(root, "source.crt");
  mustRun("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key,
    "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  return { key, cert };
}

function makePackage(root) {
  if (process.env.INSTALL_PACKAGE) {
    const bytes = fs.readFileSync(process.env.INSTALL_PACKAGE);
    const checksum = fs.readFileSync(`${process.env.INSTALL_PACKAGE}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (checksum !== crypto.createHash("sha256").update(bytes).digest("hex")) throw new Error("正式包与构建校验文件不一致");
    return { archive: path.resolve(process.env.INSTALL_PACKAGE), bytes, checksum };
  }
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.cpSync(path.join(projectRoot, "src"), path.join(packageRoot, "src"), { recursive: true });
  fs.cpSync(path.join(projectRoot, "scripts/smoke.js"), path.join(packageRoot, "scripts/smoke.js"));
  fs.cpSync(path.join(projectRoot, "scripts/install.sh"), path.join(packageRoot, "scripts/install.sh"));
  fs.cpSync(path.join(projectRoot, "scripts/install.sh"), path.join(packageRoot, "scripts/install.sh"));
  fs.cpSync(path.join(projectRoot, "packaging/remote-exec.service"), path.join(packageRoot, "packaging/remote-exec.service"));
  fs.cpSync(path.join(projectRoot, "package.json"), path.join(packageRoot, "package.json"));
  const copiedDependencies = new Set();
  function copyDependency(dependency) {
    if (copiedDependencies.has(dependency)) return;
    copiedDependencies.add(dependency);
    const source = path.dirname(require.resolve(`${dependency}/package.json`));
    fs.cpSync(source, path.join(packageRoot, "node_modules", dependency), { recursive: true });
    const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    for (const child of Object.keys(metadata.dependencies || {})) copyDependency(child);
  }
  for (const dependency of Object.keys(JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).dependencies)) copyDependency(dependency);
  fs.mkdirSync(path.join(packageRoot, "runtime/bin"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(packageRoot, "runtime/bin/node"));
  fs.chmodSync(path.join(packageRoot, "runtime/bin/node"), 0o755);
  fs.writeFileSync(path.join(packageRoot, "manifest.json"), JSON.stringify({
    version: packageVersion,
    nodeVersion: process.version,
    platform: "linux",
    arch: "x64",
  }, null, 2) + "\n");
  const archive = path.join(root, "remote-exec-linux-x64.tar.gz");
  mustRun("tar", ["-czf", archive, "-C", packageRoot, "."]);
  const bytes = fs.readFileSync(archive);
  return { archive, bytes, checksum: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function makeSystemctl(root) {
  const bin = path.join(root, "tmp/fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -u
state=/run/fixture
unit=/etc/systemd/system/remote-exec.service
pidfile="$state/remote-exec.pid"
mkdir -p "$state"
pid() { [[ -s "$pidfile" ]] && cat "$pidfile"; }
is_running() { local p; p="$(pid)"; [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; }
start_service() {
  [[ ! -e "$state/fail-start" ]] || { echo 'fixture: forced service start failure' >&2; return 1; }
  local command
  command="$(sed -n 's/^ExecStart=//p' "$unit")"
  [[ -n "$command" ]] || return 1
  exec 9>&-
  nohup bash -c "$command" >>"$state/remote-exec.log" 2>&1 &
  echo "$!" >"$pidfile"
  sleep 0.25
  is_running || { rm -f "$pidfile"; return 1; }
}
stop_service() {
  local p i
  p="$(pid)"
  if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
    kill -TERM "$p" 2>/dev/null || true
    for i in {1..50}; do
      kill -0 "$p" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$p" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}
case "$1" in
  show) echo 255 ;;
  cat) cat "$unit" ;;
  daemon-reload) exit 0 ;;
  is-active) is_running ;;
  is-enabled) [[ -e "$state/enabled" ]] ;;
  enable)
    touch "$state/enabled"
    if [[ " $* " == *' --now '* ]]; then start_service; fi
    ;;
  disable) rm -f "$state/enabled"; if [[ " $* " == *' --now '* ]]; then stop_service; fi ;;
  *) echo "fixture systemctl 不支持: $*" >&2; exit 2 ;;
esac
`);
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash
if [[ -e /run/fixture/offline ]]; then
  echo 'curl called in local package mode' >>/run/fixture/unexpected-network
  exit 1
fi
args=()
for arg in "$@"; do
  case "$arg" in
    https://github.com/JhihJian/remote-exec/releases/latest)
      echo "$arg" >>/run/fixture/downloads
      arg="$SOURCE_URL/github/latest" ;;
    https://github.com/JhihJian/remote-exec/releases/download/*)
      echo "$arg" >>/run/fixture/downloads
      arg="$SOURCE_URL/github/\${arg#https://github.com/JhihJian/remote-exec/releases/download/}" ;;
  esac
  args+=("$arg")
done
exec /usr/bin/curl "\${args[@]}"
`);
  fs.chmodSync(path.join(bin, "curl"), 0o755);
  fs.writeFileSync(path.join(bin, "journalctl"), "#!/usr/bin/env bash\ncat /run/fixture/remote-exec.log 2>/dev/null || true\n");
  fs.chmodSync(path.join(bin, "systemctl"), 0o755);
  fs.chmodSync(path.join(bin, "journalctl"), 0o755);
}

function makeRoot(root) {
  for (const dir of ["etc", "opt", "root", "var", "run", "tmp"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["os-release", "passwd", "group"]) fs.copyFileSync(`/etc/${file}`, path.join(root, "etc", file));
  if (fs.existsSync("/etc/alternatives")) fs.cpSync("/etc/alternatives", path.join(root, "etc/alternatives"), { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(path.join(root, "etc/systemd/system"), { recursive: true });
  fs.mkdirSync(path.join(root, "etc/ssl"), { recursive: true });
  for (const file of ["/etc/ssl/openssl.cnf"]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(root, "etc/ssl", path.basename(file)));
  if (fs.existsSync("/etc/ssl/certs")) fs.cpSync("/etc/ssl/certs", path.join(root, "etc/ssl/certs"), { recursive: true });
  if (fs.existsSync("/etc/hosts")) fs.copyFileSync("/etc/hosts", path.join(root, "etc/hosts"));
  if (fs.existsSync("/etc/resolv.conf")) fs.copyFileSync("/etc/resolv.conf", path.join(root, "etc/resolv.conf"));
  fs.mkdirSync(path.join(root, "run/lock"), { recursive: true });
  fs.mkdirSync(path.join(root, "run/fixture"), { recursive: true });
  makeSystemctl(root);
}

function scenarioScript() {
  return String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/tmp/fixture-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CURL_CA_BUNDLE="$SOURCE_CA"
run_install() { bash /tmp/install.sh --address 127.0.0.1 --port "$SERVICE_PORT" --run-user root "$@"; }
expect_fail() { set +e; "$@" >/tmp/expect.out 2>&1; local code=$?; set -e; (( code != 0 )) || { cat /tmp/expect.out >&2; echo "应失败的命令成功: $*" >&2; exit 1; }; }

# 参数校验和截断脚本都必须在下载及写入系统目录前结束。
expect_fail bash /tmp/install.sh --port 0
expect_fail bash /tmp/install.sh --address '-bad'
expect_fail bash /tmp/install.sh --run-user nobody
expect_fail bash /tmp/install.sh --unknown value
expect_fail run_install --source "$SOURCE_URL" --package /tmp/local-package/package.tar.gz
head -n -1 /tmp/install.sh >/tmp/truncated-install.sh
bash /tmp/truncated-install.sh --address 127.0.0.1 --port "$SERVICE_PORT" --run-user root --source "$SOURCE_URL" >/tmp/truncated.out 2>&1
[[ ! -e /opt/remote-exec ]] || { echo '截断脚本执行了安装入口' >&2; exit 1; }

# 首次下载校验失败不能创建安装目录或凭据。
expect_fail run_install --source "$BAD_SOURCE_URL"
grep -q 'SHA-256' /tmp/expect.out || { cat /tmp/expect.out >&2; exit 1; }
[[ ! -e /opt/remote-exec && ! -e /etc/remote-exec && ! -e /root/remote-exec-access ]]

# systemctl fixture 强制第一次启动失败，验证凭据在失败后留下且下一次可以恢复。
touch /run/fixture/fail-start
expect_fail run_install
[[ -s /root/remote-exec-access/token.txt ]] || { cat /tmp/expect.out >&2; echo '启动失败后 token 未保留' >&2; exit 1; }
[[ ! -e /run/fixture/remote-exec.pid ]] || { echo '启动失败后服务仍存活' >&2; exit 1; }
token_before=$(cat /root/remote-exec-access/token.txt)
rm /run/fixture/fail-start

# 首次成功走真实 HTTPS 下载、SHA-256 校验、TLS/WSS smoke 和实际 daemon。
run_install || { cat /run/fixture/remote-exec.log >&2; exit 1; }
[[ "$(sha256sum /root/remote-exec-access/token.txt | awk '{print $1}')" == "$(cat /etc/remote-exec/credentials/token.sha256)" ]] || { echo 'token hash mismatch' >&2; exit 1; }
[[ -s /run/fixture/remote-exec.pid ]] || { cat /run/fixture/remote-exec.log >&2; exit 1; }
pid_before=$(cat /run/fixture/remote-exec.pid)
token_after=$(cat /root/remote-exec-access/token.txt)
[[ "$token_before" == "$token_after" ]] || { echo '重试时 token 被轮换' >&2; exit 1; }

# 同一命令重跑不重启进程，也不改变凭据。
run_install
[[ "$pid_before" == "$(cat /run/fixture/remote-exec.pid)" ]] || { echo '相同命令重跑改变了 PID' >&2; exit 1; }
[[ "$token_after" == "$(cat /root/remote-exec-access/token.txt)" ]] || { echo '相同命令重跑改变了 token' >&2; exit 1; }

# 停止服务后使用本地包重装：缺少校验文件或校验错误都不能覆盖既有安装。
[[ "$(grep -c 'releases/latest$' /run/fixture/downloads)" == 1 ]]
grep -q 'releases/download/v' /run/fixture/downloads
systemctl disable --now remote-exec.service
[[ ! -e /run/fixture/remote-exec.pid ]] || { echo 'stop 后 daemon 仍存活' >&2; exit 1; }
local_hash=$(sha256sum /opt/remote-exec/install.json)
local_token=$(cat /root/remote-exec-access/token.txt)
local_downloads=$(wc -l </run/fixture/downloads)
touch /run/fixture/offline
mv /tmp/local-package/package.tar.gz.sha256 /tmp/local-package/package.tar.gz.sha256.disabled
expect_fail run_install --package /tmp/local-package/package.tar.gz
[[ "$local_hash" == "$(sha256sum /opt/remote-exec/install.json)" ]] || { echo '缺少本地 hash 改写了安装目录' >&2; exit 1; }
mv /tmp/local-package/package.tar.gz.sha256.disabled /tmp/local-package/package.tar.gz.sha256
printf '%064d  package.tar.gz\n' 0 >/tmp/local-package/package.tar.gz.sha256
expect_fail run_install --package /tmp/local-package/package.tar.gz
[[ "$local_hash" == "$(sha256sum /opt/remote-exec/install.json)" ]] || { echo '错误本地 hash 改写了安装目录' >&2; exit 1; }
printf '%s  package.tar.gz\n' "$(sha256sum /tmp/local-package/package.tar.gz | awk '{print $1}')" >/tmp/local-package/package.tar.gz.sha256
run_install --package /tmp/local-package/package.tar.gz
systemctl is-active --quiet remote-exec.service
local_pid=$(cat /run/fixture/remote-exec.pid)
(cd /tmp/local-package && run_install --package ./package.tar.gz)
[[ "$local_pid" == "$(cat /run/fixture/remote-exec.pid)" ]] || { echo '本地包重跑改变了 PID' >&2; exit 1; }
[[ "$local_hash" == "$(sha256sum /opt/remote-exec/install.json)" ]] || { echo '本地重装改写了安装配置' >&2; exit 1; }
[[ ! -e /run/fixture/unexpected-network ]] || { echo '本地包模式调用了 curl' >&2; exit 1; }
rm /run/fixture/offline
[[ "$local_token" == "$(cat /root/remote-exec-access/token.txt)" ]] || { echo '本地重装轮换了 token' >&2; exit 1; }
[[ "$local_downloads" == "$(wc -l </run/fixture/downloads)" ]] || { echo '本地包模式访问了网络下载' >&2; exit 1; }

# smoke 使用错误 token 必须被真实 WSS 服务拒绝。
printf '%s\n' wrong-token >/tmp/wrong-token
expect_fail /opt/remote-exec/runtime/bin/node /opt/remote-exec/scripts/smoke.js --port "$SERVICE_PORT" --ca /etc/remote-exec/credentials/server.crt --token-file /tmp/wrong-token --expected-user root
grep -q '401' /tmp/expect.out || { cat /tmp/expect.out >&2; echo '错误 token 未触发认证拒绝' >&2; exit 1; }

# 发布包 hash 错误不得覆盖既有安装。
installed_hash=$(sha256sum /opt/remote-exec/install.json)
expect_fail bash /tmp/install.sh --address 127.0.0.1 --port "$SERVICE_PORT" --run-user root --source "$BAD_SOURCE_URL"
[[ "$installed_hash" == "$(sha256sum /opt/remote-exec/install.json)" ]] || { echo '错误 hash 改写了安装目录' >&2; exit 1; }
[[ "$token_after" == "$(cat /root/remote-exec-access/token.txt)" ]] || { echo '错误 hash 改写了 token' >&2; exit 1; }

# 验证实际导出的客户端地址和端口。
/opt/remote-exec/runtime/bin/node -e 'const cfg=require("/root/remote-exec-access/hosts.json");const h=Object.values(cfg.hosts)[0];if(h.host!=="127.0.0.1"||h.port!==Number(process.argv[1]))throw Error("客户端配置地址或端口无效")' "$SERVICE_PORT"
[[ "$(stat -c %a /root/remote-exec-access/token.txt)" == 600 ]]
[[ "$(stat -c %a /etc/remote-exec/credentials/server.key)" == 600 ]]

echo 'install runner: all checks passed'
`;
}

async function systemdTest(certificate, sourcePort) {
  const name = `rex-install-${crypto.randomBytes(6).toString("hex")}`;
  const image = process.env.INSTALL_SYSTEMD_IMAGE || "remote-exec-install-systemd:test";
  const port = sourcePort + 1;
  const docker = (...args) => mustRun("docker", args, { timeout: 60000 });
  const exec = (script) => docker("exec", name, "bash", "-ec", script);
  const install = `CURL_CA_BUNDLE=/tmp/source.crt bash /tmp/install.sh --source https://127.0.0.1:${sourcePort}/release --address 127.0.0.1 --port ${port}`;
  try {
    docker("run", "--privileged", "--network", "host", "-d", "--name", name, image);
    exec('for n in {1..30}; do state=$(systemctl show -p SystemState --value 2>/dev/null || true); if [[ "$state" == running || "$state" == degraded ]]; then exit 0; fi; sleep 1; done; exit 1');
    docker("cp", installScript, `${name}:/tmp/install.sh`);
    docker("cp", certificate.cert, `${name}:/tmp/source.crt`);
    // 异步执行使本进程可持续响应 HTTPS 下载。
    const executeInstall = () => new Promise((resolve, reject) => {
      const child = childProcess.spawn("docker", ["exec", name, "bash", "-ec", install], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`systemd 安装失败: ${code}`)));
    });
    await executeInstall();
    const before = exec("systemctl show remote-exec -p MainPID --value; sha256sum /root/remote-exec-access/token.txt").stdout;
    await executeInstall();
    const after = exec("systemctl show remote-exec -p MainPID --value; sha256sum /root/remote-exec-access/token.txt").stdout;
    if (before !== after) throw new Error("真实 systemd 重复安装改变了 PID 或凭据");
    exec("systemctl is-active --quiet remote-exec; systemctl is-enabled --quiet remote-exec; test \"$(systemctl show remote-exec -p User --value)\" = remote-exec");
    exec(`/opt/remote-exec/runtime/bin/node -e 'const h=Object.values(require("/root/remote-exec-access/hosts.json").hosts)[0];if(h.host!=="127.0.0.1"||h.port!==${port})throw Error("客户端接入配置错误")'`);
    docker("restart", name);
    exec(`for n in {1..20}; do if /opt/remote-exec/runtime/bin/node /opt/remote-exec/scripts/smoke.js --port ${port} --ca /etc/remote-exec/credentials/server.crt --token-file /root/remote-exec-access/token.txt --expected-user remote-exec; then exit 0; fi; sleep 1; done; exit 1`);
    console.log("PASS 正式包、专用用户、真实 systemd、重复安装与重启后恢复");
  } finally {
    run("docker", ["rm", "-f", name], { timeout: 30000, stdio: "ignore" });
  }
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("install runner 仅支持 Linux x86_64");
  if (!fs.existsSync(installScript)) throw new Error(`缺少安装脚本: ${installScript}`);
  if (!process.env.INSTALL_SYSTEMD) {
    if (childProcess.spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status !== 0) throw new Error("缺少 bwrap，无法执行安装测试");
    const probe = run("bwrap", ["--share-net", "--unshare-user", "--uid", "0", "--gid", "0", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"], { stdio: "ignore" });
    if (probe.status !== 0) throw new Error("bwrap 不可用：无法创建 uid0 user namespace，安装测试拒绝静默跳过");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-install-runner-"));
  let server;
  try {
    makeRoot(root);
    const source = makePackage(root);
    const localPackageDir = path.join(root, "tmp/local-package");
    fs.mkdirSync(localPackageDir, { recursive: true });
    fs.copyFileSync(source.archive, path.join(localPackageDir, "package.tar.gz"));
    fs.writeFileSync(path.join(localPackageDir, "package.tar.gz.sha256"), `${source.checksum}  package.tar.gz\n`);
    const certificate = makeCertificate(root);
    const badBytes = Buffer.concat([source.bytes, Buffer.from("corrupt")]);
    let interruptedDownload = false;
    let resumedDownload = false;
    const sourcePort = await new Promise((resolve, reject) => {
      server = https.createServer({ key: fs.readFileSync(certificate.key), cert: fs.readFileSync(certificate.cert) }, (request, response) => {
        if (request.url.endsWith("/github/latest")) {
          response.writeHead(302, { location: `/release/github/tag/v${packageVersion}` });
          response.end();
          return;
        }
        if (request.url.includes("/github/tag/")) {
          response.end("version");
          return;
        }
        const bad = request.url.startsWith("/bad");
        if (!request.url.endsWith(".sha256")) {
          if (!bad && request.headers.range) {
            const offset = Number(request.headers.range.match(/^bytes=(\d+)-$/)?.[1]);
            if (!Number.isInteger(offset) || offset <= 0 || offset >= source.bytes.length) {
              response.writeHead(416); response.end(); return;
            }
            resumedDownload = true;
            response.writeHead(206, { "content-range": `bytes ${offset}-${source.bytes.length - 1}/${source.bytes.length}`, "content-length": source.bytes.length - offset });
            response.end(source.bytes.subarray(offset));
          } else if (!bad && !interruptedDownload) {
            interruptedDownload = true;
            response.writeHead(200, { "content-length": source.bytes.length, connection: "close" });
            response.end(source.bytes.subarray(0, Math.floor(source.bytes.length / 2)));
          } else {
            response.writeHead(200, { "content-type": "application/gzip" });
            response.end(bad ? badBytes : source.bytes);
          }
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${source.checksum}  remote-exec-linux-x64.tar.gz\n`);
      });
      server.on("connection", (socket) => { socket.setTimeout(15000, () => socket.destroy()); });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    if (process.env.INSTALL_SYSTEMD) {
      if (!process.env.INSTALL_PACKAGE) throw new Error("真实 systemd 验收需通过 INSTALL_PACKAGE 指定正式构建包");
      await systemdTest(certificate, sourcePort);
      if (!resumedDownload) throw new Error("未验证网络中断续传");
      return;
    }
    fs.copyFileSync(installScript, path.join(root, "tmp/install.sh"));
    fs.writeFileSync(path.join(root, "tmp/scenario.sh"), scenarioScript());
    fs.chmodSync(path.join(root, "tmp/install.sh"), 0o755);
    fs.chmodSync(path.join(root, "tmp/scenario.sh"), 0o755);
    const env = {
      SOURCE_URL: `https://127.0.0.1:${sourcePort}/release`,
      BAD_SOURCE_URL: `https://127.0.0.1:${sourcePort}/bad`,
      SOURCE_CA: "/tmp/source.crt",
      SERVICE_PORT: String(sourcePort + 1),
    };
    fs.copyFileSync(certificate.cert, path.join(root, "tmp/source.crt"));
    const args = ["--share-net", "--die-with-parent", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid",
      "--ro-bind", "/", "/", "--bind", path.join(root, "etc"), "/etc", "--bind", path.join(root, "opt"), "/opt",
      "--bind", path.join(root, "root"), "/root", "--bind", path.join(root, "var"), "/var", "--bind", path.join(root, "run"), "/run",
      "--bind", path.join(root, "tmp"), "/tmp", "--proc", "/proc", "--dev", "/dev", "--setenv", "PATH", "/tmp/fixture-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--setenv", "SOURCE_URL", env.SOURCE_URL, "--setenv", "BAD_SOURCE_URL", env.BAD_SOURCE_URL, "--setenv", "SOURCE_CA", env.SOURCE_CA,
      "--setenv", "SERVICE_PORT", env.SERVICE_PORT, "/bin/bash", "/tmp/scenario.sh"];
    const result = await new Promise((resolve, reject) => {
      const process = childProcess.spawn("bwrap", args, { stdio: "inherit" });
      process.once("error", reject);
      process.once("exit", (code, signal) => resolve({ status: code === null ? 1 : code, signal }));
    });
    if (result.status !== 0) throw new Error(`安装 runner 验收失败，退出码 ${result.status}`);
    if (!resumedDownload) throw new Error("未验证网络中断续传");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`install runner 失败：${error.message}`);
  process.exitCode = 1;
});
