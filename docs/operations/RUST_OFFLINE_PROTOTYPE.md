# Rust 离线原型

## 目标与交付边界

Rust 原型用于验证小于 1MB 的离线部署包：Linux 目标机通过 SSH 接收本地准备好的文件，安装与启动阶段只使用本机已有的 Bash 和常见系统工具。网络、TLS 和应用运行库静态编入服务程序，证书在部署端生成。

当前原型已实现 TLS/WSS、`exec`、`exec.stream`、`file.read`、`file.write`、HTTPS 上传和下载。现有 Node 客户端能够直连接入，命令保持 `bash -lc` 语义。正式 Node daemon、发布包和升级流程继续独立维护。

| 范围 | 当前状态 |
| --- | --- |
| Linux x86_64 musl 静态程序 | 已构建并验证 |
| 完整部署压缩包严格小于 1,000,000 字节 | 构建脚本强制检查，包含服务器证书与私钥 |
| 禁网、无 Node/npm/Cargo/OpenSSL 的环境 | 已验证普通用户离线安装和启动 |
| TLS 鉴权、命令、文件协议与异常输入 | 持久化回归测试覆盖 |
| relay、`deploy.ssh`、supervisor 排空与无中断升级 | 后续迁移范围，原型未知方法返回 `-32601` |
| SSH 上传断点续传、自动登记主机、开机启动 | 后续部署流程范围 |
| ARM、其他内核与其他真实目标设备 | 待取得设备事实后验证 |

## 模块职责

服务实现位于 `prototype/rust-daemon/`。`main.rs` 解析配置、加载 TLS 凭据、监听端口和管理连接任务。`server.rs` 使用 Hyper 接收 HTTP 请求并移交经认证的 WebSocket 会话，`rpc.rs` 处理请求顺序、响应和断连取消。`exec.rs` 管理 Bash 子进程组，`files.rs` 管理常规文件和同目录临时文件。`auth.rs` 校验 token 哈希。

Rustls/ring 承担 TLS，Tungstenite 承担 WebSocket 帧处理，Hyper 承担 HTTP/1.1 消息边界，Tokio 承担异步 I/O 和子进程。应用模块保持与正式服务相同的 TLS 与 token 权限边界。原型只监听 TLS，不提供明文远程接口。

同连接最多保留一个等待请求，额外请求使连接关闭。普通命令的 stdout/stderr 各自默认截断至 1MiB，仍继续读取管道。流式输出以最多 16KiB 片段发送，发送停滞超过 30 秒关闭连接并取消命令。超时退出码为 124。连接取消、服务 SIGTERM 和命令结束清理进程组时使用 SIGKILL。原型 SIGTERM 取消正在执行的工作，排空升级属于后续迁移范围。

RPC 的文件写入与 HTTPS 上传均先写同目录临时文件，再原子 rename。失败和取消删除临时文件。HTTPS 上传计算 SHA-256，下载保留 Content-Length，由客户端校验哈希。Base64 使用严格解码，数值参数要求正整数。

## 构建与安装

构建端需要 Rust 工具链、`x86_64-unknown-linux-musl` 标准库、musl-gcc、OpenSSL、Node 和常见归档工具。目标机需要 Linux x86_64、Bash、可写且可执行的目录。安装脚本使用 tar 解包之后的 coreutils，程序本身只依赖内核和系统 Bash。业务命令使用的程序仍由目标机提供。

在项目根目录构建某一设备的专用包：

```bash
rustup target add x86_64-unknown-linux-musl
bash scripts/build-rust-prototype.sh --address 192.0.2.10 --output-dir dist/rust-device
```

`--address` 必须是客户端实际使用的 DNS 名或 IPv4，`--port` 默认 8791。构建脚本固定使用 musl target、锁文件和 release 配置，检查 ELF 的动态解释器和动态依赖，并对最终压缩包执行体积门禁。输出目录中已存在包或接入资料时停止，以保留既有凭据。

输出包括：

- `remote-exec-rust-prototype-linux-x64.tar.gz`：服务二进制、服务器证书、私钥、token 哈希、启动与安装脚本、清单、项目与依赖许可证。
- 相邻 `.sha256` 文件：整个包的 SHA-256。
- `access/`：只留在部署端的 token 明文、可信服务器证书和客户端主机配置模板。
- `size.json`：完整归档与解压后二进制的字节数。

部署包包含服务器私钥，按凭据保护。每台设备使用独立输出目录和凭据。证书有效期 365 天，续期属于部署维护流程。

先在部署端验证包，传到目标机的权限为 700 的空目录：

```bash
cd dist/rust-device
sha256sum --check remote-exec-rust-prototype-linux-x64.tar.gz.sha256
scp remote-exec-rust-prototype-linux-x64.tar.gz user@192.0.2.10:/PRIVATE/STAGING/
```

目标机离线解包、安装并前台启动：

```bash
cd /PRIVATE/STAGING
tar -xzf remote-exec-rust-prototype-linux-x64.tar.gz
bash install.sh /ABSOLUTE/PATH/remote-exec-rust-prototype
bash /ABSOLUTE/PATH/remote-exec-rust-prototype/run.sh
```

安装器复制到独立的新目录，不修改正式服务。`run.sh` 监听 `0.0.0.0`，使用当前用户权限运行。前台退出即停止，原型只适合验证与独立试用。客户端修改 `access/hosts.json` 的 CA 和 token 路径，再合并到现有主机配置。TLS 连接必须信任指定证书并匹配证书 SAN。

### 一行 SSH 安装

已在 xiaomi 实机验证以下用户路径。构建端使用目标地址生成专用包，包通过 SSH 标准输入传输，目标机自动解包并离线安装：

```bash
bash scripts/build-rust-prototype.sh --address 192.168.1.63 --port 18791 --output-dir dist/rust-xiaomi
cat dist/rust-xiaomi/remote-exec-rust-prototype-linux-x64.tar.gz | \
  ssh 63 'set -e; base="$HOME/remote-exec-rust-test"; rm -rf "$base"; mkdir -m 700 "$base"; mkdir "$base/stage"; tar -xzf - -C "$base/stage"; bash "$base/stage/install.sh" "$base/installed"; bash "$base/installed/run.sh"'
```

这条命令使用免密 SSH，不依赖 `remote_upload` 或目标机公网访问。正式常驻运行需要额外提供目标侧进程管理器 unit；本次 xiaomi 验证创建了独立的用户级 systemd unit `remote-exec-rust-xiaomi-test.service`，并验证了 `enable`、`restart`、`stop/start`、端口恢复和 `NRestarts=0`。测试端口为 `18791`，原有 `8791` 服务未修改，测试结束后已清理 unit、目录和凭据。

## 验证与测量

```bash
cargo fmt --manifest-path prototype/rust-daemon/Cargo.toml -- --check
cargo clippy --locked --manifest-path prototype/rust-daemon/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path prototype/rust-daemon/Cargo.toml
node test/rust-prototype/runner.js
bash test/rust-prototype/offline.sh
```

协议回归使用现有 Node WSS 客户端和独立的 HTTPS、原始 TLS 输入。覆盖可信证书与错误证书、错误 token、Origin、非法握手、中文命令、cwd、退出码、双流截断、请求顺序、实时输出、超时和断连进程组清理、二进制文件往返、chunked 上传、100MB 文件哈希一致、上传中断清理、畸形帧和服务退出清理。

离线验证需要构建端已有 Docker 和 `debian:12-slim` 镜像，脚本使用 `--pull never --network none`，以普通用户在只读基础镜像和独立可执行临时目录内安装启动。测试确认环境中缺少 Node、npm、Cargo、rustc 和 OpenSSL，包完整性、静态链接与体积门禁均通过。

### 实测结果

使用 Rust 1.97.1、`x86_64-unknown-linux-musl`、锁文件和 release 配置，包含许可证及设备凭据的最终服务器包为 **956,142 字节**，解压后的服务二进制为 **1,799,024 字节**。完整包相对 1,000,000 字节上限剩余 43,858 字节。随机凭据与编译器会影响后续构建大小，以每次完整资产测量为准。

16 项外部协议与异常行为检查、2 项 Rust 单元测试、格式和 Clippy 检查、静态链接检查与禁网离线安装启动均已通过。100MB 上传下载的大小与 SHA-256 一致。xiaomi 实机完成 TLS/WSS、命令、流式输出、文件 RPC、HTTPS 上传下载和 systemd 重启验证。离线容器与 xiaomi 使用的内核和 CPU 之外，其他内核及真实目标设备仍需验证。

客户端 token 保留在本机，服务器包只携带哈希。

## 完整迁移的验收条件

完整 Rust 替换须保留项目现有顶层能力并通过对应测试：relay 的网段、目标证书和错误分类，SSH 网关部署的指纹校验及主机登记，supervisor 的候选验证、切换、旧连接排空和回滚。

弱网部署流程还需要保存上传进度、断线重连后续传、远端完整性核验和验收后的原子启用。该流程完成前，原型通过普通 SSH/SFTP 传包。最终包体积须在这些能力加入后再次测量，目标设备须验证 CPU、内核、Bash、执行目录权限与服务启动方式。
