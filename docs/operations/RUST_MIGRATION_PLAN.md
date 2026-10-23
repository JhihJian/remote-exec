# Rust 完整替换 Node 迁移设计

状态：已评审修订。本文是迁移的主控文档，记录终态架构、阶段划分、兼容决策与退出条件。

## 1. 目标与边界

最终目标：Rust 成为 remote-exec 的正式实现，Node 不再承担生产运行、部署、升级和主要客户端职责。使用者获得与 Node 版等价的远程执行、文件传输、relay、部署、升级、配置管理和操作入口。

不新增 RBAC、Windows、IPv6 relay 等与替换无关的能力。

## 2. 能力差异图（基于 4cb742a 调查）

### 2.1 目标机服务（daemon）

| 能力 | Node 现状 | Rust 现状 | 结论 |
| --- | --- | --- | --- |
| exec / exec.stream / file.read / file.write | 完整，测试覆盖 | 完整，行为基本等价 | 已覆盖；Phase 1 已对齐进程组 SIGTERM→2 秒 KILL，终止后的管道排空仍保留尾部输出 |
| /upload /download | 完整 | 完整（更严格：fsync、超时） | 已覆盖 |
| relay | 完整（错误带 data.stage、外层 timeoutMs 覆盖、Binary 帧仅 Text 终态） | 完整（错误带 stage、外层 timeoutMs、TLS pin 有效期检查） | Phase 1 已对齐主要错误阶段、总超时和证书有效期；Binary 帧仍需协议专项复核 |
| deploy.ssh 网关 RPC | 完整 | 缺失 | Phase 4 在 Rust daemon 实现（russh + SFTP） |
| lifecycle 排空（readyz 503、RPC -32020、WS 升级 1013、drain 超时强关） | 完整 | 已实现并有专项测试 | Phase 1 已关闭；supervisor 无中断升级依赖此行为 |
| SIGTERM 优雅退出 | 完整 | 已实现排空、在途请求完成、超时强关 | Phase 1 已关闭 |
| --insecure-http 回环明文 | 有（仅测试使用） | 无 | 决策：Rust 保持仅 TLS，不实现明文模式 |

### 2.2 服务生命周期与升级（supervisor）

| 能力 | Node 现状 | Rust 现状 | 结论 |
| --- | --- | --- | --- |
| 固定入口 TCP 代理、旧连接保留 | 完整 | 完整 | 已覆盖 |
| register/start/promote/rollback/drain/retire 控制面 | 完整 | 完整（语义略有差异：retire 先删记录后 SIGTERM 不等待；start spawn 路径无测试） | 需补测试与语义对齐 |
| 生产安装集成（systemd、generation 目录、重启恢复） | 无（发布包不含 supervisor，升级编排只存在于测试脚本） | 无 | Rust 必须超出 Node 交付，属于重新设计而非照搬 |
| 升级编排（上传、解包、候选启动、promote、排空、retire 窗口） | 无（仅测试脚本驱动控制面） | 无 | 需要交付正式编排入口 |

### 2.3 部署与主机登记

| 能力 | Node 现状 | Rust 现状 | 结论 |
| --- | --- | --- | --- |
| rex deploy 直连 SSH 部署 | 完整（指纹校验、密码/密钥/agent 认证、sudo、验收、登记） | 缺失 | Phase 3b 在 rex 实现（russh） |
| rex deploy 网关部署（deploy.ssh） | 完整（暂存上限与清理、网段校验、脱敏） | 缺失 | Phase 4：daemon RPC + rex 编排 |
| 发布包下载（GitHub latest、断点续传、HTTPS-only） | 完整 | 缺失 | Phase 3b 纳入 rex |
| 主机登记（hosts.json / ssh-hosts.json / credentials） | 完整 | 缺失 | rex 读写同一格式，天然兼容；须显式覆盖 servername/cwd/via 字段 |
| 目标机一键安装 install.sh | 完整（--address/--port/--run-user/--source、flock、幂等、凭据保留、Ubuntu/Debian x64 矩阵） | 原型（无凭据保留、幂等、迁移、ARM64 OS 矩阵） | Phase 4 正式版 |

### 2.4 客户端与操作入口

| 能力 | Node 现状 | Rust 现状 | 结论 |
| --- | --- | --- | --- |
| 客户端库 + TUI | 完整（readline 交互、:host/:cd/:timeout/:flow、二进制预览） | 已交付（rust/rex，readline 交互、一次性子命令、smoke） | Phase 3a 已交付；TUI 收窄为 readline 交互，不做全屏框架 |
| Pi extension | 独立实现，不依赖 Node remote-exec 运行时 | 协议兼容 Rust daemon | 保留：Pi 宿主适配层边界；Phase 1 后对 Rust daemon 冒烟，Phase 5 终验 |
| smoke 安装验收 | 需要 Node（scripts/smoke.js） | rex 自带 smoke 子命令，目标机无需 Node | Phase 3a 已交付 |

### 2.5 发布

| 能力 | Node 现状 | Rust 现状 | 结论 |
| --- | --- | --- | --- |
| build-release + GitHub release | 完整（x64 Node 包，无体积门禁） | 原型构建（<2MB 门禁，x64+ARM64） | Phase 4 Rust 正式发布流程 |
| 客户端分发 | rex.sh → node src/cli/main.js | rex.sh 全部子命令指向 rex 二进制 | tarball 分发在 Phase 5 收口 |

### 2.6 生产机群事实（迁移对象盘点）

| 主机 | 架构/OS | 现状 | 备注 |
| --- | --- | --- | --- |
| nm105 | x86_64 | Node gateway，自定义 unit remote-exec-gateway.service，root 运行，`--relay-allow 172.16.126.0/24`，凭据在 /etc/remote-exec-gateway/credentials | 迁移必须保留 unit 参数（端口 18790/443 入口、relay-allow、凭据路径） |
| xiaomi | x86_64 Ubuntu | daemon 运行中（8791） | 本机局域网，先行试点 |
| nm24/21/22/23 | ARM64 openEuler | 已运行 Rust 原型（18791） | 后续平移到正式布局 |
| nm101/108/109 | x86_64 | Node daemon（经 nm105 relay） | |
| QC71/101/194/195 | x86_64 CentOS7 | daemon 运行中（3006） | 内核 3.10，musl 静态兼容性需验证 |
| HG1 | 未知 | 经 VPN 中转 | 迁移顺序最后 |

## 3. 终态架构

### 3.1 交付物与代码结构

Cargo workspace（Phase 0 决策细节）：

- `remote-execd`（服务包，目标机）：单二进制，子命令 `daemon`（默认）、`supervisor`、`ctl`、`smoke`。musl 静态 x86_64 与 ARM64，压缩包 <2,000,000 字节门禁。
- `rex`（客户端包，操作机）：单二进制，子命令默认交互模式、`deploy`、`upgrade`、`exec`、`hosts`。独立体积预算，musl 静态双架构。
- 共享 crate：协议常量、hosts.json 解析、TLS/token 客户端逻辑（workspace 内复用，禁止复制粘贴）。

Pi extension 保持 TypeScript 与现有工具面，属于 Pi 宿主适配层，不依赖 Node remote-exec 代码。

### 3.2 目录与配置布局（目标机）

- `/etc/remote-exec/credentials/{server.crt,server.key,token.sha256}`：凭据（沿用现有路径；自定义路径安装通过参数保留）
- `/opt/remote-exec/versions/<id>/`：服务包解包目录，root 属主；id 为版本号+包哈希前缀
- `/opt/remote-exec/current`：指向 active 版本目录的符号链接，root 属主
- `/etc/remote-exec/supervisor-state.json`：active/previous generation 状态，root 属主
- `/run/remote-exec/supervisor.sock`：控制面 Unix socket，root 属主 0600（unit 用 RuntimeDirectory）
- systemd：`remote-exec-supervisor.service`，**root 运行**，supervisor 绑定固定外部端口后 **drop 到服务用户** 再 spawn daemon generation；daemon 只监听 127.0.0.1 随机端口并经 stdout 回报

权限模型（安全边界不变的关键决策）：versions、state、控制面均 root 属主；token 持有者（即 daemon 服务用户）无法修改启动版本、无法触达控制面。升级和迁移走 SSH root 通道，与部署同信任级别。相比 Node 现状（/opt root 属主、无 token 升级路径），该设计不扩大 token 权限边界；若 supervisor 以服务用户运行则 versions 必然服务用户可写，token 持有者将获得 systemd 级持久化，故不采用。

### 3.3 升级模型

- supervisor 是 systemd 常驻进程（root），重启后从 state 文件恢复 active generation（重新 spawn）。state 缺失或损坏时拒绝启动并报错（安全默认，SSH 修复），不以 current 链接猜测。
- 升级通道：SSH root（与部署同信任级别）。`rex upgrade <host> --package <pkg>`：
  1. 上传包与校验和到目标机（SSH/SFTP 或既有 /upload 通道）
  2. SSH 执行 `remote-execd ctl upgrade --package <path>`：校验 SHA-256 → 解包到 versions/<id> → supervisor start 候选 → readyz 验证 → promote → 原子更新 state 与 current 链接 → 返回。**不在同一次调用内 retire**（ctl 自身经旧 generation 的连接会阻塞 retire 的连接归零条件）。
  3. rex 经新 generation 轮询 `ctl status`，待旧 generation 连接归零或到达窗口，再执行 `ctl retire <name>`。
- 回滚：`remote-execd ctl rollback`（supervisor 重新走 promote+readyz）或 rex upgrade --rollback。
- 候选失败（spawn 失败、readyz 失败、TLS 失败）：保持 active 不变，清理候选目录，ctl 返回错误。
- test/upgrade/upgrade.js 的零中断门禁由 Phase 2 交付的 Rust 升级验收套件接替（loopback 全流程 + 实机），不遗留门禁真空。

### 3.4 Node→Rust 迁移路径（既有安装）

一次性短暂重启，事务性步骤，全部经 SSH root 通道执行（不用 daemon exec，避免 cgroup 自杀与权限不足）：

1. **预检**：读取既有 unit 的 ExecStart，解析 `--host/--port/--relay-allow/--cert/--key/--token-sha256-file` 与运行用户；解析失败或参数无法映射时拒绝迁移。
2. **并置安装**：安装 Rust versions 布局、supervisor unit（保持解析出的端口/relay-allow/凭据路径/运行用户）、state 文件；此阶段不触碰 Node 服务，任何失败零影响。
3. **交接**：单条命令 `systemctl stop <旧unit> && systemctl start remote-exec-supervisor`（SSH 会话内原子窗口，秒级）。
4. **验收**：用既有 CA/token 走真实 TLS+WSS+命令验收（客户端配置零改动，凭据不动）。
5. **回滚**：`systemctl stop remote-exec-supervisor && systemctl start <旧unit>`；Node 目录与 unit 全程未动。

中断窗口为服务重启时长，文档如实标注；Rust↔Rust 升级才是无中断路径。

### 3.5 安全边界（不变项与修正）

- token 权限模型不变：持有 token 即 daemon 运行用户权限；服务端只存 SHA-256；升级/迁移/部署走 SSH 通道。
- TLS：daemon 仅监听 TLS（Rust 不实现 --insecure-http）；relay 目标校验为“信任调用方提供 CA + SAN + **有效期**”；修正 Rust 原型 PinnedCertificateVerifier 短路分支跳过 notBefore/notAfter 的弱化（Phase 1）。
- relay：白名单（默认私网段）、IPv4 字面量、单跳、方法白名单、嵌套拒绝；网关自定义 --relay-allow 在迁移中保留。
- SSH 部署：指纹 SHA256 记录与不匹配拒绝；密码仅存内存与加密连接；transcript 脱敏。
- 凭据文件权限 0700/0600、原子写入、同目录临时文件原子替换、上传 SHA-256 校验。

## 4. 阶段划分与退出条件

### Phase 0：结构决策与体积测量
范围：russh+russh-sftp 体积三方案实测（daemon 嵌入 / 仅 rex 嵌入 / 拆分 deploy 二进制，x86_64 与 ARM64 各测）；workspace 结构落地；2MB 门禁结论写回本文档。
退出条件：三个方案的压缩包与二进制体积数字在案；crate 结构决策定案。

### Phase 1：服务包协议生产化（已完成实现，待提交）
范围：lifecycle 排空（readyz 503、RPC -32020、WS 1013、drain 超时强关、SIGTERM 优雅退出、--drain-timeout-ms）；exec SIGTERM 宽限、stream 16KB 分片与停滞检测；relay stage/timeoutMs/Binary 帧对齐；PinnedCertificateVerifier 有效期修正；生产凭据路径参数化。基线测试逐条对应 test/daemon/lifecycle.js 与 test/integration/client.js 口径。
退出条件：排空与差异对齐在 Rust daemon 有回归证据；体积门禁复测；Pi extension 对 Rust daemon 冒烟通过。当前证据：`runner.js` 18 项、`drain.js` 6 项、Rust 单测 3 项、clippy `-D warnings`、supervisor 回归、x86_64 离线包 1,144,354 字节并通过无 Node/OpenSSL/Cargo 网络隔离安装。
剩余阻断项：ARM64 重新打包及离线安装证据、Pi extension 冒烟、正式 supervisor/systemd/ctl 交付、deploy.ssh、rex 客户端和生产迁移尚未完成，因此不能据此宣布 Rust 已替换 Node。

### Phase 2：supervisor 生产化与升级编排
范围：start spawn 路径、retire 语义对齐（SIGTERM 等待退出）、权限 drop（root supervisor → 服务用户 daemon）、状态持久化与重启恢复（含 state 损坏拒绝启动）、systemd unit、ctl upgrade/rollback/retire/status（两段式）、候选失败保护。
退出条件：loopback 全流程自动化测试（安装→升级→在途操作不断→回滚→重启恢复→候选失败保持 active→retire 保护）；x86_64 与 ARM64 实机各一次真实升级（脚本驱动，不依赖 rex UX）。

进度（2026-10）：loopback 套件 `test/rust-prototype/phase2.js` 已交付五场景：升级编排（含 {version_dir} 占位符）、在途零中断、回滚、retire 保护与两段式；重启恢复 respawn 与 stale 清理；候选失败保护与坏包拒绝；损坏/未知 state 拒绝启动；--run-user 降权路径（同 uid；跨 uid 属实机门禁）。ctl 子命令（rust/daemon/src/ctl.rs）与生产 systemd unit 模板（rust/packaging/remote-exec-supervisor.service）已交付。

实机验收（2026-10-23）：`test/rust-prototype/build-phase2-live-bundle.sh` + `phase2-live.py`（python3 标准库驱动，TLS 真实 daemon backend）十项检查：首次升级、TLS 代理、二次升级、在途连接零中断、新连接路由、回滚、retire、supervisor 重启恢复、两段式收尾。x86_64（xiaomi，Python 3.14/OpenSSL 3.5）与 ARM64（nm24 openEuler 22.03，Python 3.9/OpenSSL 1.1.1）均 10/10 通过。兼容性发现：CA 需带 keyUsage 扩展（新 OpenSSL 严格校验），且 basicConstraints 不能经 -addext 重复添加（openssl 1.1.1 产生重复扩展被 rustls 拒绝）。Phase 2 退出条件全部达成。

### Phase 3a：rex 核心（已完成）
范围：hosts.json/ssh-hosts.json/credentials 兼容读写（含 servername/cwd/via）；exec/exec.stream/file.read/file.write/upload/download/relay；smoke 子命令暴露；readline 交互模式（:host/:cd/:timeout/:flow/:hosts/:q、二进制预览、退出摘要）；rex.sh 切换入口。
退出条件：rex 对 Rust daemon 全操作路径可用；现有 ~/.config/remote-exec/hosts.json 直接可用；日常操作可用 rex dogfood。

进度（2026-10-23）：`rust/rex`（bin rex）交付，依赖 tokio-rustls/tokio-tungstenite/reqwest(rustls)/rustyline，不入 daemon 2MB 门禁。loopback 套件 `test/rust-prototype/phase3a.js` 14 项通过（一次性 exec/read/write、30MB upload/download 哈希、relay 信封、smoke、hosts 并行探测、交互管道 PWD 跟随与退出摘要、Node config-store 互读）；Rust 单测 3 项（register 格式与 Node 互通、幂等/端点冲突、指纹 key 格式）。dogfood：xiaomi 旁挂 Rust daemon（0.0.0.0:8792，jhihjian，注册名 xiaomi-rust）实机验证 exec/smoke/read/write/upload/download/交互全套；现有 hosts.json 全部 14 台直接可用（Node 旧证书主机报 CaUsedAsEndEntity，属预期，Phase 5 迁移时换新证书）。双架构 musl 静态构建通过（x86_64 2,646,928 / ARM64 2,232,568 字节，无体积门禁）。rex deploy 仍由 rex.sh 路由到 Node（Phase 3b 移除）。

### Phase 3b：rex 部署与升级 UX（已完成）
范围：deploy 直连（russh：指纹、密码/密钥/agent、sudo、验收、登记、脱敏）；发布包下载（GitHub latest、断点续传、HTTPS-only）；upgrade 编排 UX（两段式 ctl 驱动）。
退出条件：隔离环境直连部署测试通过；对试点主机完成一次真实 Rust↔Rust 无中断升级。

进度（2026-10-23）：`rex deploy`/`rex upgrade` 交付（russh default-features=false + ring，仅 rex 依赖不入 daemon 2MB 门禁）。deploy：SSH 直连密钥/密码/agent 认证、指纹校验（known > --host-key > 交互确认）、sudo NOPASSWD/-S 路径、发布包本地/下载双源、验收（PinnedVerifier 钉住叶子证书，兼容自签与 CA 签发）、登记；upgrade：RawBundle sha256 校验、首装 bootstrap（解包 + 拉起 supervisor 单元 + 统一 ctl upgrade 建 generation）、两段式 retire、rollback 由 rex 同步 current 链接。隔离 E2E `test/rust-prototype/phase3b.js` 13 项通过（双容器 systemd/SSH：密钥/密码/错误密码/幂等/指纹拒绝/别名冲突/坏包/ops sudo/首装/零中断/回滚/坏包自动回滚）。实机验收（2026-10-23）：MACO → xiaomi docker privileged 容器（EasyTier 10.144.144.4，生产布局 CA+leaf+token+supervisor systemd 单元）完成 rex upgrade 首装 v1 → 持 WSS 连接零中断升级 v2（同连接持续可用）→ rollback 回 v1，全部通过后清理。发现并修复：CLI 选项在目标解析后统一合并（--port 任意顺序生效）、OpenSSH exit-status 在 EOF 后发送（channel 循环 Eof 不 break）、SFTP 需先 request_subsystem、ctl 输出多行 JSON 整体解析。rex.sh 不再路由 Node，deploy/upgrade 全部走 rex。Node 包自签叶子布局 rex 常规 CA 验证报 CaUsedAsEndEntity 属预期（deploy 验收用钉住验证），Phase 5 迁移统一换 CA+leaf。

### Phase 4：daemon deploy.ssh 与发布流程
范围：daemon deploy.ssh（russh、SFTP、暂存上限与清理、网段校验、脱敏）；rex 网关部署 E2E；正式构建脚本与发布流程（双架构）；正式 install.sh（参数面 --address/--port/--run-user/--source、flock、幂等、凭据保留、OS 矩阵 x64+ARM64）；Node→Rust 迁移脚本（3.4 流程）。
退出条件：网关部署隔离测试通过；双架构离线安装测试通过；体积门禁复测并记录；试点实机完成一次 Node→Rust 迁移演练（含回滚演练）。

### Phase 5：切换与退役
范围：生产机群迁移（顺序：xiaomi → nm24/21/22/23 平移 → nm101/108/109 → QC71/101/194/195 → nm105 网关最后 → HG1）；文档/架构治理状态同步；Node 代码标记为回滚资产；发布流程切换到 Rust。
退出条件：全部生产实例运行 Rust 且日常操作无回归；至少一次生产 Node 回滚演练可用；Pi extension 终验通过；Node 不在任何生产路径；文档与治理状态一致。

## 5. Node 代码处置

| 代码 | 迁移期角色 | 最终处置 |
| --- | --- | --- |
| src/daemon、src/supervisor | 行为基线与回滚资产 | 观察期保留，之后随版本清理 |
| src/client、src/tui、src/cli、src/deploy | rex Rust 版对照 | 观察期保留后清理 |
| scripts/install.sh、build-release.sh、release.yml（Node） | 回滚资产 | 观察期后停用 |
| test/integration、test/deploy、test/install、test/upgrade | 兼容基线（Node 客户端作为测试桥接件） | 协议契约部分改造为针对 Rust 实现；Node 专属流程测试随退役移除 |
| test/rust-prototype/* | Rust 回归测试 | 演进为正式测试 |
| pi-extension | 不变 | 不变（Pi 宿主边界） |

## 6. 已决策事项

1. Rust daemon 仅 TLS，不实现 --insecure-http（生产与测试路径均强制 TLS）。
2. 升级/迁移走 SSH root 通道，不做 token-only 升级；supervisor 以 root 运行并 drop 权限 spawn daemon。
3. ctl upgrade 两段式：promote 后返回，retire 由外部驱动。
4. Node→Rust 一次性迁移接受秒级重启窗口，事务性步骤保证可回滚。
5. TUI 收窄为 readline 交互，不做全屏框架。
