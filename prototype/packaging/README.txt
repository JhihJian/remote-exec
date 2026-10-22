remote-exec Rust 离线原型

这是独立的验证包，支持 TLS/WSS、exec、exec.stream、file.read、file.write、单跳 relay、HTTPS 上传和下载。
Rust 服务自身支持受白名单限制的单跳 relay，但不实现网关 SSH 部署、supervisor 无中断升级和弱网 SSH 断点续传；root 安装器已支持通过 systemd 常驻。

运行条件：Linux x86_64 或 ARM64（aarch64）、Bash、可写目录。安装脚本还使用常见的 coreutils。
程序静态链接，不需要 Node、npm、Cargo、OpenSSL 或目标机访问公网。
命令仍通过系统 Bash 执行，需要执行的业务工具由目标操作系统提供。

1. 在部署端核对相邻的 SHA-256 校验文件。
2. 使用 `cat 包名 | ssh 目标 'mkdir -m 700 -p 目录 && tar -xzf - -C 目录'` 通过 SSH 标准输入传输并解包；也可以使用 SFTP。
3. 在目标机执行 `bash install.sh [--systemd] /绝对路径/独立安装目录`。
4. 执行 `bash /绝对路径/独立安装目录/run.sh`。

run.sh 在 0.0.0.0 监听 port 文件中的端口，以当前用户权限运行。
证书与私钥已经在部署端生成，证书有效期 365 天。整个包包含服务器私钥，需要保护。
客户端 token 明文仅保存在部署端的 access 目录，不在服务器包内。
将 access/hosts.json 中路径改为本机的绝对路径，再合并到现有客户端配置。
客户端必须信任 access/server.crt，连接地址须匹配证书 SAN。
前台进程退出即停止，SIGTERM/断连会取消活跃命令。root 用户可使用 `--systemd` 安装并启用 `remote-exec-rust-prototype.service`；排空升级属于后续迁移范围。
