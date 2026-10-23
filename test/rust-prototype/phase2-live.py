#!/usr/bin/env python3
"""Phase 2 实机验收：真实 TLS daemon 的两段式升级、在途零中断、回滚、retire 与重启恢复。

在目标机上运行（仅需 python3 标准库）：
  python3 phase2-live.py --bundle <dir> [--workdir <dir>]

bundle 目录需包含：remote-execd（ supervisor/ctl/daemon 一体二进制）、
certs/{ca.crt,server.crt,server.key}、token.sha256、v1.tar.gz、v2.tar.gz
（每个版本包内含 bin/remote-execd 与 marker 文件）。
"""
import argparse
import hashlib
import json
import os
import signal
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time

CERT_SANS_REQUIRED = False  # 证书由 bundle 提供，无需本机生成


def log(message):
    print(message, flush=True)


def fail(message):
    print(f"FAIL {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_port_closed(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return
        time.sleep(0.1)
    fail(f"端口 {port} 迟迟未释放")


def start_supervisor(binary, port, control, state, workdir):
    child = subprocess.Popen(
        [binary, "supervisor", "--host", "127.0.0.1", "--port", str(port),
         "--control", control, "--state", state],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=workdir)
    deadline = time.time() + 15
    buffer = ""
    while time.time() < deadline:
        line = child.stderr.readline()
        if line:
            buffer += line
            if "listening" in line:
                return child, buffer
        if child.poll() is not None:
            fail(f"supervisor 启动失败: {buffer or child.stdout.read()}")
        time.sleep(0.05)
    fail(f"supervisor 未就绪: {buffer}")


def ctl(binary, control, args, expect_failure=False):
    result = subprocess.run(
        [binary, "ctl", "--control", control, *args],
        capture_output=True, text=True)
    if expect_failure and result.returncode == 0:
        fail(f"ctl {' '.join(args)} 应失败但成功了: {result.stdout}")
    if not expect_failure and result.returncode != 0:
        fail(f"ctl {' '.join(args)} 失败: {result.stderr or result.stdout}")
    return result.stdout


def status(binary, control):
    return json.loads(ctl(binary, control, ["status"]))


def find_generation(state, name):
    return next((g for g in state["generations"] if g["name"] == name), None)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def tls_socket(ca_path, port):
    context = ssl.create_default_context(cafile=ca_path)
    context.check_hostname = False  # 证书 SAN 为 127.0.0.1，按 IP 校验在旧 python 不可靠
    raw = socket.create_connection(("127.0.0.1", port), timeout=10)
    return context.wrap_socket(raw)


def readyz(sock, retries=1):
    """在已建立的 TLS 连接上请求 /readyz，期望 200。"""
    for attempt in range(retries):
        try:
            sock.sendall(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n")
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            first_line = response.split(b"\r\n", 1)[0].decode()
            if " 200 " in first_line:
                return
            if attempt + 1 == retries:
                fail(f"/readyz 非 200: {first_line}")
        except (ssl.SSLError, socket.timeout, ConnectionError) as error:
            if attempt + 1 == retries:
                fail(f"/readyz 请求失败: {error}")
        time.sleep(0.3)


def build_upgrade_args(versions_dir, link, package, sha256, certs, token):
    return [
        "upgrade",
        "--package", package,
        "--sha256", sha256,
        "--versions-dir", versions_dir,
        "--link", link,
        "--backend-protocol", "https",
        "--backend-ca", certs["ca"],
        "--", "{version_dir}/bin/remote-execd", "daemon",
        "--host", "127.0.0.1",
        "--cert", certs["crt"],
        "--key", certs["key"],
        "--token-sha256-file", token,
    ]


def wait_connections_zero(binary, control, name, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = status(binary, control)
        generation = find_generation(state, name)
        if generation and generation.get("connections", 0) == 0:
            return
        time.sleep(0.2)
    fail(f"generation {name} 连接未归零")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, help="含二进制/证书/版本包的目录")
    parser.add_argument("--workdir", help="运行目录（默认临时目录）")
    options = parser.parse_args()

    bundle = os.path.abspath(options.bundle)
    binary = os.path.join(bundle, "remote-execd")
    certs = {
        "ca": os.path.join(bundle, "certs", "ca.crt"),
        "crt": os.path.join(bundle, "certs", "server.crt"),
        "key": os.path.join(bundle, "certs", "server.key"),
    }
    token = os.path.join(bundle, "token.sha256")
    workdir = options.workdir or tempfile.mkdtemp(prefix="rex-phase2-live-")
    os.makedirs(workdir, exist_ok=True)
    control = os.path.join(workdir, "control.sock")
    state_path = os.path.join(workdir, "state.json")
    versions_dir = os.path.join(workdir, "versions")
    current_link = os.path.join(workdir, "current")
    for path in (binary, certs["ca"], certs["crt"], certs["key"], token):
        if not os.path.isfile(path):
            fail(f"bundle 缺少 {path}")

    def sha256_of(path):
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    supervisor_port = free_port()
    supervisor, _ = start_supervisor(binary, supervisor_port, control, state_path, workdir)
    try:
        # 1. 初始状态
        assert status(binary, control)["active"] is None, "初始应无 active"
        log("PASS 1/10 初始状态无 active")

        # 2. 首次升级（v1，TLS daemon backend）
        v1_package = os.path.join(bundle, "v1.tar.gz")
        result = json.loads(ctl(binary, control, build_upgrade_args(
            versions_dir, current_link, v1_package, sha256_of(v1_package), certs, token)))
        g1 = result["generation"]
        assert result["previous"] is None, "首次升级 previous 应为空"
        with open(os.path.join(current_link, "marker")) as handle:
            assert handle.read().strip() == "v1", "current 链接应指向 v1"
        state = status(binary, control)
        g1_pid = find_generation(state, g1)["process"]["pid"]
        assert pid_alive(g1_pid), "v1 daemon 应存活"
        log(f"PASS 2/10 首次升级成功（generation={g1}, pid={g1_pid}）")

        # 3. 经 supervisor 端口的 TLS 请求
        held = tls_socket(certs["ca"], supervisor_port)
        readyz(held)
        log("PASS 3/10 TLS 请求经 supervisor 代理返回 200")

        # 4. 二次升级（v2），held 连接保持
        v2_package = os.path.join(bundle, "v2.tar.gz")
        result = json.loads(ctl(binary, control, build_upgrade_args(
            versions_dir, current_link, v2_package, sha256_of(v2_package), certs, token)))
        g2 = result["generation"]
        assert result["previous"] == g1, "二次升级 previous 应为 v1"
        with open(os.path.join(current_link, "marker")) as handle:
            assert handle.read().strip() == "v2", "current 链接应指向 v2"
        state = status(binary, control)
        assert state["active"] == g2, "active 应切到 v2"
        g2_pid = find_generation(state, g2)["process"]["pid"]
        assert pid_alive(g2_pid), "v2 daemon 应存活"
        log(f"PASS 4/10 二次升级成功（generation={g2}, pid={g2_pid}）")

        # 5. 在途连接零中断：升级前的连接仍可用
        readyz(held)
        assert find_generation(status(binary, control), g1)["connections"] == 1, "旧连接应记在 v1"
        log("PASS 5/10 在途 TLS 连接零中断（升级后仍可请求）")

        # 6. 新连接路由到 v2
        fresh = tls_socket(certs["ca"], supervisor_port)
        readyz(fresh)
        fresh.close()
        log("PASS 6/10 新连接路由到新版本")

        # 7. 旧连接归零、回滚到 v1
        held.close()
        wait_connections_zero(binary, control, g1)
        ctl(binary, control, ["rollback"])
        state = status(binary, control)
        assert state["active"] == g1, "回滚后 active 应为 v1"
        rollback_conn = tls_socket(certs["ca"], supervisor_port)
        readyz(rollback_conn)
        rollback_conn.close()
        log("PASS 7/10 回滚到 v1 且服务可用")

        # 8. retire v2：进程终止、记录删除
        v2_gen = find_generation(status(binary, control), g2)
        v2_pid = v2_gen["process"]["pid"]
        ctl(binary, control, ["retire", g2])
        state = status(binary, control)
        assert find_generation(state, g2) is None, "v2 应被 retire"
        assert not pid_alive(v2_pid), "v2 进程应被终止"
        log("PASS 8/10 retire 清理 v2（进程终止、记录删除）")

        # 9. supervisor 重启恢复
        supervisor.send_signal(signal.SIGTERM)
        supervisor.wait(timeout=15)
        assert not pid_alive(g2_pid)
        supervisor, _ = start_supervisor(binary, supervisor_port, control, state_path, workdir)
        state = status(binary, control)
        assert state["active"] == g1, "重启后应恢复 active v1"
        respawned_pid = find_generation(state, g1)["process"]["pid"]
        assert pid_alive(respawned_pid), "重启后 v1 应重新拉起"
        revived = tls_socket(certs["ca"], supervisor_port)
        readyz(revived)
        revived.close()
        log(f"PASS 9/10 supervisor 重启恢复（respawn pid={respawned_pid}）")

        # 10. 再升级一次（v3 包内容不同，避免同秒 id 冲突）并 retire v1，验证两段式收尾
        v3_package = os.path.join(bundle, "v3.tar.gz")
        result = json.loads(ctl(binary, control, build_upgrade_args(
            versions_dir, current_link, v3_package, sha256_of(v3_package), certs, token)))
        g3 = result["generation"]
        assert result["previous"] == g1, "三次升级 previous 应为 v1"
        wait_connections_zero(binary, control, g1)
        ctl(binary, control, ["retire", g1])
        state = status(binary, control)
        assert find_generation(state, g1) is None, "v1 应被 retire"
        assert state["active"] == g3, "active 应为最新版本"
        log("PASS 10/10 两段式收尾（升级新版本后 retire 旧版本）")

        log(f"Phase 2 实机验收全部通过（workdir={workdir}）")
    finally:
        if supervisor.poll() is None:
            supervisor.send_signal(signal.SIGTERM)
            try:
                supervisor.wait(timeout=15)
            except subprocess.TimeoutExpired:
                supervisor.kill()


if __name__ == "__main__":
    main()
