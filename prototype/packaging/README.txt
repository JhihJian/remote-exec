remote-exec Rust 离线原型

这是独立的验证包，支持 TLS/WSS、exec、exec.stream、file.read、file.write、HTTPS 上传和下载。
relay、网关 SSH 部署、supervisor 无中断升级、弱网 SSH 断点续传和开机启动尚未迁移。

运行条件：Linux x86_64、Bash、可写目录。安装脚本还使用常见的 coreutils。
程序静态链接，不需要 Node、npm、Cargo、OpenSSL 或目标机访问公网。
命令仍通过系统 Bash 执行，需要执行的业务工具由目标操作系统提供。

1. 在部署端核对相邻的 SHA-256 校验文件，使用 SSH/SFTP 将完整包传到目标机。
2. 在目标机的权限为 700 的空目录中解包，使用 tar -xzf 包名。
3. bash install.sh /绝对路径/独立安装目录
4. bash /绝对路径/独立安装目录/run.sh

run.sh 在 0.0.0.0 监听 port 文件中的端口，以当前用户权限运行。
证书与私钥已经在部署端生成，证书有效期 365 天。整个包包含服务器私钥，需要保护。
客户端 token 明文仅保存在部署端的 access 目录，不在服务器包内。
将 access/hosts.json 中路径改为本机的绝对路径，再合并到现有客户端配置。
客户端必须信任 access/server.crt，连接地址须匹配证书 SAN。
前台进程退出即停止，SIGTERM/断连会取消活跃命令。排空升级属于后续迁移范围。
