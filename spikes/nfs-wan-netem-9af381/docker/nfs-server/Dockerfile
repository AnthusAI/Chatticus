FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    nfs-kernel-server \
    nfs-ganesha \
    nfs-ganesha-vfs \
    rpcbind \
    iproute2 \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /exports/workspace /var/lib/nfs /run/nfs-ganesha /var/run/ganesha

COPY ganesha.conf /etc/ganesha/ganesha.conf
COPY nfs-healthcheck.sh /usr/local/bin/nfs-healthcheck.sh
COPY start-nfs.sh /usr/local/bin/start-nfs.sh

RUN chmod +x /usr/local/bin/nfs-healthcheck.sh /usr/local/bin/start-nfs.sh

EXPOSE 2049

ENTRYPOINT ["/usr/local/bin/start-nfs.sh"]
