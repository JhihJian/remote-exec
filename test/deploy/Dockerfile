FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server sudo curl ca-certificates openssl util-linux procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /etc/ssh/sshd_config.d \
    && printf 'PermitRootLogin yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/00-deploy-test.conf \
    && ssh-keygen -A \
    && useradd --create-home --shell /bin/bash ops \
    && printf 'ops ALL=(ALL:ALL) ALL\nDefaults:ops timestamp_timeout=0\n' > /etc/sudoers.d/deploy-test \
    && chmod 0440 /etc/sudoers.d/deploy-test \
    && systemctl enable ssh.service

# Passwords are assigned over docker exec stdin by the runner, never baked in.
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
