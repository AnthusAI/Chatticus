FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    nfs-common \
    git \
    iproute2 \
    iputils-ping \
    python3 \
    python3-pip \
    findutils \
    coreutils \
    jq \
    time \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

RUN git config --global --add safe.directory '*'
