# remote-exec

面向受信任 Linux 主机的轻量远程执行 daemon。它通过 TLS、Bearer token 和 JSON-RPC 风格协议提供以下能力：

- 执行远程 `bash -lc` 命令，并返回退出码、标准输出和标准错误。
- 流式接收长时间运行命令的输出，客户端断开时终止对应进程组。
- 读写绝对路径文件，以及通过 HTTPS 流式上传和下载大文件。
- 通过单跳 relay 网关访问同一内网中的多个 daemon。
- 使用 TUI、Node.js 客户端库或 Pi extension 接入。

项目适合个人实验室、受控内网、自动化 agent 和 CI 辅助节点。它的授权模型是“持有 token 即拥有 daemon 运行用户的权限”，部署前请阅读[安全边界](#安全边界)。

## 项目状态

当前版本为 `1.0.0`，运行时依赖 Node.js 18 或更高版本，以及 `ws` 库。目标运行环境为 Linux，命令执行依赖 `bash`、`setsid` 等常见系统工具。

已验证的能力包括：

- 30 项端到端协议、认证、命令执行、文件传输和 relay 回归测试。
- WebSocket 畸形帧和超长帧输入验证。
- TLS 证书校验、错误 token、超时、客户端断连和进程组清理。
- 100MB 文件上传和下载的哈希一致性验证。

## 安全边界

remote-exec 是高权限远程执行服务，适用范围由部署网络和 daemon 运行用户共同决定。

- 有效 token 可以在 daemon 运行用户权限范围内执行 `bash -lc`，并读写该用户可访问的绝对路径。
- 服务端只保存 token 的 SHA-256，不保存 token 明文。
- TLS 模式用于远程监听；`--insecure-http` 仅允许回环地址。
- relay 默认只允许回环和 RFC1918 私网地址，目标必须使用 IPv4 字面量。
- relay 只转发 `exec`、`exec.stream`、`file.read` 和 `file.write`，不支持嵌套 relay。
- `/healthz` 和 `/readyz` 用于健康检查，不需要 token。
- 上传端点按请求体持续写入临时文件。部署时应结合防火墙、网络访问控制和磁盘配额限制可访问方；当前版本没有独立的上传总大小和并发配额。

推荐的生产部署条件：

1. 使用专用的非 root 用户运行 daemon。
2. 使用 TLS，并通过 VPN 或防火墙只向受信任客户端开放端口。
3. 将 token、私钥和 token 哈希文件设置为服务用户可读。
4. 客户端校验证书，不使用绕过 TLS 校验的配置。
5. token 泄露后立即停止服务、生成新 token 并替换哈希文件。

完整的漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 快速开始

### 1. 安装依赖

```bash
npm ci
```

也可以只安装运行时依赖：

```bash
npm install --omit=dev
```

### 2. 创建证书和 token

下面的示例用于本机测试。远程部署时，应将证书 SAN 中的主机名或 IP 换成实际连接地址。

```bash
mkdir -p .personal/certs

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout .personal/certs/server.key \
  -out .personal/certs/server.crt \
  -days 3650 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

TOKEN=$(head -c 24 /dev/urandom | base64)
printf '%s' "$TOKEN" > .personal/token.txt
sha256sum .personal/token.txt | cut -d' ' -f1 > .personal/token.sha256
chmod 600 .personal/token.txt .personal/token.sha256 .personal/certs/server.key
```

`.personal/` 已加入 `.gitignore`，用于保存本机证书、token、部署资料和日志。

### 3. 启动 daemon

TLS 监听示例：

```bash
node server.js \
  --host 127.0.0.1 \
  --port 8791 \
  --cert .personal/certs/server.crt \
  --key .personal/certs/server.key \
  --token-sha256-file .personal/token.sha256
```

远程内网监听示例：

```bash
node server.js \
  --host 0.0.0.0 \
  --port 8791 \
  --cert .personal/certs/server.crt \
  --key .personal/certs/server.key \
  --token-sha256-file .personal/token.sha256
```

仅限本机调试的明文模式：

```bash
node server.js \
  --host 127.0.0.1 \
  --port 8791 \
  --insecure-http \
  --token-sha256-file .personal/token.sha256
```

TLS 模式的健康检查地址为 `https://127.0.0.1:8791/healthz`，明文回环模式使用 `http://127.0.0.1:8791/healthz`。自签证书需要在客户端配置为可信 CA。

## 协议

WebSocket 连接使用 JSON-RPC 风格消息：

```json
{"id":1,"method":"exec","params":{"command":"hostname"}}
```

普通响应格式为：

```json
{"id":1,"result":{"exitCode":0,"stdoutB64":"...","stderrB64":"","truncated":false}}
```

错误响应格式为：

```json
{"id":1,"error":{"code":-32602,"message":"..."}}
```

支持的方法：

| 方法 | 主要参数 | 返回内容 |
| --- | --- | --- |
| `exec` | `command`、可选 `cwd`、`timeoutMs`、`outputBytesCap` | 退出码、Base64 编码的 stdout/stderr、截断标记 |
| `exec.stream` | `command`、可选 `cwd`、`timeoutMs` | 多个 output 事件，最后返回退出码和字节数 |
| `file.read` | 绝对路径 `file` | Base64 编码的文件内容，单次读取上限 64MB |
| `file.write` | 绝对路径 `file`、Base64 编码的 `contentB64` | 写入字节数 |
| `relay` | `target`、`auth`、`request` | 目标 daemon 的结果或 relay 错误信封 |

协议行为：

- 文件和命令输出使用 Base64，保证二进制内容可传输。
- `exec` 默认超时 5 分钟，默认每个输出流最多收集 1MB。
- 超时退出码为 `124`；客户端断连时，服务端会终止对应进程组。
- `exec.stream` 以 16KB 分片发送输出，发送停滞 30 秒后终止命令。
- WebSocket 单帧上限为 64MB。
- HTTP `/upload` 和 `/download` 只支持直连 daemon，不经 relay 转发。

## 客户端

### TUI

TUI 客户端使用内置 `readline`，支持执行单条命令、切换主机、跟随日志和查看主机连通性。

```bash
node tui-client.js gateway
node tui-client.js
node tui-client.js --list
```

仓库中的 `rex.sh` 可作为全局命令入口：

```bash
./rex.sh gateway
./rex.sh hosts
```

会话命令：

| 命令 | 作用 |
| --- | --- |
| `:host [name]` | 切换或列出主机 |
| `:cd <directory>` | 修改远程工作目录 |
| `:timeout <seconds>` | 修改命令超时时间 |
| `:flow <command>` | 流式执行命令 |
| `:hosts` | 列出主机并探测延迟 |
| `:q` | 退出会话 |

### Node.js 客户端库

`lib/client.js` 提供以下接口：

- `loadConfig()`：读取 `~/.config/remote-exec/hosts.json`。
- `WssClient`：建立 TLS WebSocket 连接并调用协议方法。
- `callHost()`：统一执行直连或 relay 调用。
- `callHostStream()`：统一处理流式输出。
- `httpOp()`：直连主机的上传和下载。

主机配置示例：

```json
{
  "hosts": {
    "gateway": {
      "host": "192.0.2.10",
      "port": 8791,
      "servername": "gateway.example.test",
      "ca": "/path/to/server.crt",
      "tokenFile": "/path/to/token.txt",
      "cwd": "/home/ops",
      "note": "内网网关"
    }
  }
}
```

客户端默认校验证书。IP 地址连接时，证书应在 SAN 中包含该 IP；使用域名连接时，应配置匹配的 `servername` 和 CA。

### Pi extension

`pi-extension/remote-exec.ts` 将 daemon 接入 Pi，提供以下工具：

| 工具 | 作用 |
| --- | --- |
| `remote_bash` | 执行远程 shell 命令 |
| `remote_read` | 读取远程文件，返回给模型的内容上限为 100KB |
| `remote_write` | 写入 UTF-8 文本文件 |
| `remote_upload` | 流式上传本地文件 |
| `remote_download` | 流式下载远程文件 |

注册 extension：

```bash
ln -s "$(pwd)/pi-extension/remote-exec.ts" \
  ~/.pi/agent/extensions/remote-exec.ts
```

主机清单仍使用 `~/.config/remote-exec/hosts.json`。新增或修改配置后，重启 Pi 会话以刷新工具中的主机列表。

## Relay 网关

relay 适合“外部只开放一个端口，后面有多台内网 daemon”的网络结构。客户端连接网关，网关再连接目标 daemon。

主机配置中为目标增加 `via`：

```json
{
  "hosts": {
    "gateway": {
      "host": "192.0.2.10",
      "port": 8791,
      "ca": "/path/to/gateway.crt",
      "tokenFile": "/path/to/gateway.token"
    },
    "backend": {
      "host": "192.0.2.15",
      "port": 8791,
      "ca": "/path/to/backend.crt",
      "tokenFile": "/path/to/backend.token",
      "via": "gateway"
    }
  }
}
```

relay 的默认约束：

- 目标地址只接受 IPv4 字面量，默认允许回环和 RFC1918 私网网段。
- 可通过重复传入 `--relay-allow <cidr>` 自定义允许网段。
- 内层只允许 `exec`、`exec.stream`、`file.read` 和 `file.write`。
- 目标 token 和 CA 随请求传递，网关不落盘。
- 单网关 relay 并发上限为 8，连接预算和内层超时均有上限。
- `via` 只支持一层，上传和下载需要直连目标主机。

## 远程部署

daemon 可以部署为目标主机上的普通 Node.js 进程。最小文件集合为 `server.js`、`package.json` 和 `node_modules/ws`，也可以直接部署 npm 打包产物。

```bash
npm pack
scp remote-exec-1.0.0.tgz user@host:~/
ssh user@host 'mkdir -p ~/remote-exec && tar -xzf ~/remote-exec-1.0.0.tgz -C ~/remote-exec --strip-components=1'
ssh user@host 'cd ~/remote-exec && npm install --omit=dev'
```

生产环境建议使用 systemd 或其他进程管理器运行，并为 daemon 配置专用用户、工作目录、证书权限、日志轮转和防火墙规则。具体主机的部署自动化应由使用方根据自身网络、用户和凭证管理方式维护。

## 开发与测试

安装完整依赖后运行全部门禁：

```bash
npm ci
npm test
```

测试命令包括：

- `npm run check`：检查 JavaScript 语法。
- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run test:integration`：生成临时证书和 token，启动 daemon，运行端到端测试和畸形输入验证。

单独运行协议回归：

```bash
node test-client.js \
  --port 8791 \
  --token-file .personal/token.txt \
  --ca .personal/certs/server.crt
```

单独运行畸形输入验证：

```bash
node fuzz-client.js \
  --port 8791 \
  --token-file .personal/token.txt \
  --ca .personal/certs/server.crt
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `server.js` | TLS/WSS daemon、命令执行、文件接口和 relay |
| `lib/client.js` | Node.js 公共客户端库 |
| `tui-client.js` | 交互式终端客户端 |
| `pi-extension/remote-exec.ts` | Pi 工具扩展 |
| `test-client.js` | 协议和端到端回归客户端 |
| `fuzz-client.js` | WebSocket 畸形输入验证 |
| `test-runner.js` | 测试环境编排和临时凭证生成 |
| `SECURITY.md` | 安全边界与漏洞报告政策 |

## 许可证

本项目使用 ISC License，详见 [LICENSE](LICENSE)。
