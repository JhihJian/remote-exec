# remote-exec 一键安装方案

## 核心方案

用户 SSH 登录机器后执行一条命令，安装脚本自动准备运行文件、证书和访问凭据，启动一个开机自启的 systemd 服务，最后给出客户端接入资料。

首次安装直接运行 daemon。现有 supervisor 和无中断升级机制保持独立，首次安装无需引入多版本管理和切换事务。

状态：已实现首版，安装脚本、自包含发布包和 systemd unit 已纳入代码。支持范围与验证结果以 README 和测试为准。

## 用户怎么安装

root 用户执行：

```bash
curl -fsSL https://github.com/JhihJian/remote-exec/releases/latest/download/install.sh | bash
```

普通用户执行：

```bash
curl -fsSL https://github.com/JhihJian/remote-exec/releases/latest/download/install.sh | sudo bash
```

普通用户可能需要输入 sudo 密码。完全无人值守时，需要 root 或免密 sudo。

脚本默认监听 `0.0.0.0:8791`，从机器已有的非回环 IPv4 地址生成证书 SAN，并加入 hostname、localhost 和 127.0.0.1。安装结束列出可用地址。客户端通过域名、NAT 地址或其他未列出的地址连接时，在同一条命令后补充参数：

```bash
curl -fsSL https://github.com/JhihJian/remote-exec/releases/latest/download/install.sh | bash -s -- --address node.example.com
```

普通用户在这个例子中将 `bash -s` 换成 `sudo bash -s`。`--address` 用于补充证书身份和客户端配置，监听地址保持 `0.0.0.0`。支持 `--port`、`--run-user remote-exec|root` 和 `--source HTTPS发布目录`。默认从 GitHub 稳定发布解析并固定版本；重复安装沿用已安装版本，不自动升级。多个本机地址并存时，脚本列出选择，客户端按实际可达地址接入。

## 脚本只做五件事

1. **检查环境**：支持 Ubuntu 22.04/24.04、Debian 12 的 x86_64 机器，要求 systemd、root 权限以及 curl、tar、OpenSSL、sha256sum、flock 等基础工具。条件不满足就明确报错。
2. **下载运行包**：安装入口将当前稳定版解析为具体版本，随后下载并校验该版本的应用包，成功输出明确版本号。包中携带 Node 和运行依赖，校验后安装到 `/opt/remote-exec`。用户无需安装 Node、npm 或 Git。
3. **准备凭据**：首次生成自签 TLS 证书和随机 token，daemon 只读取 token 哈希。配置放在 `/etc/remote-exec`，证书、私钥和 token 哈希归服务用户所有，目录 0700、文件 0600。客户端接入资料另存 root 专属目录，目录 0700、文件 0600。
4. **启动服务**：创建专用用户和 `remote-exec.service`，启用开机自启与故障重启。远程命令默认以该用户身份执行，需要 root 执行时显式指定 `--run-user root`。
5. **确认可用**：检查服务状态，用生成的证书和 token 通过实际监听端口执行一次 TLS/WSS 命令测试。通过后打印服务地址、运行身份、接入资料位置及 SSH 下载示例，失败时给出原因和日志命令。

安装成功表示目标机器上的服务正常。客户端取得证书、token 和主机配置后，按现有 `hosts.json` 格式接入。接入资料通过 SSH 下载，脚本不修改防火墙、云安全组或另一台电脑的配置。

## 重复执行和失败处理

- 相同版本再次安装时保留证书、token 和配置，检查服务即可。检测到其他版本或现有 supervisor 部署时，提示使用相应升级流程，安装命令不负责升级。
- 全程持有安装锁，防止两个安装同时执行。端口被其他程序占用时直接报错。
- 先下载到临时目录，网络中断时保留下载进度并续传，完整校验后再落盘。下载失败时保留机器原状。
- 安装入口将逻辑写在函数中，文件末尾才调用入口，减少管道下载中断造成半段脚本执行的风险。发布源通过 HTTPS 提供脚本和包，包哈希用于完整性检查。
- 首次启动失败时停用本次新建的服务，保留凭据和日志供重试。已有服务及非本次创建的文件保持原状。

## 交付与验收

只需交付安装脚本、自包含运行包和一个 systemd unit。客户端接入沿用现有配置方式。

- 发布前验证四件事：干净机器一条命令安装成功，服务停止后再次执行能恢复，同一命令执行两次凭据保持有效，下载或启动失败能明确报错并安全重试。`npm run test:install` 使用 bubblewrap 隔离系统目录、模拟 systemd 入口，执行真实 HTTPS 下载与 TLS/WSS 测试。发布流程再使用正式包在 Debian 12 容器内验证真实 systemd、默认专用用户和容器重启后的自动恢复，测试不重启宿主机。

构建与正式包验收：

```bash
npm ci
bash scripts/build-release.sh
INSTALL_PACKAGE="$PWD/dist/remote-exec-linux-x64.tar.gz" npm run test:install
docker build -t remote-exec-install-systemd:test test/install
INSTALL_SYSTEMD=1 INSTALL_PACKAGE="$PWD/dist/remote-exec-linux-x64.tar.gz" npm run test:install
```

构建默认携带 Node 24.13.1，使用 Node 官方 HTTPS 发布包与 SHA-256 清单校验。构建端需要 Node/npm、tar/xz 等工具。安装测试需要 Linux x86_64、bubblewrap 和可用用户命名空间，真实 systemd 测试需要 Docker。tag `v<package.json版本>` 触发 `.github/workflows/release.yml`，全部验证通过后发布安装脚本、包和校验文件。


该安装方式后续可以采用短暂重启来升级。需要单端口无中断升级的设备，单独按[现有升级方案](REMOTE_EXEC_ZERO_DOWNTIME_UPGRADE.md)部署 supervisor；从直接 daemon 迁移到稳定入口需要一次受控切换。
