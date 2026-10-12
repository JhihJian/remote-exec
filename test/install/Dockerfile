FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates openssl util-linux procps && rm -rf /var/lib/apt/lists/*
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
