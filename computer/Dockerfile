# Chatticus computer
#
# Long-lived Linux workplace. Same image on Fargate, EC2, and local Docker.
# Not a Lambda runtime. Build from the repository root:
#   docker build -f computer/Dockerfile -t chatticus-computer .

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CHATTICUS_LIVE_ROOT=/var/lib/chatticus/computer \
    CHATTICUS_SNAPSHOT_STORE=/var/lib/chatticus/store

# Ubuntu's chromium-browser package is a snap stub and fails in Fargate
# ("requires the chromium snap"). Debian ships a real Chromium deb for ARM64.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    chromium \
    fonts-liberation \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY python /opt/chatticus/src
RUN python3 -m venv /opt/chatticus/venv \
    && /opt/chatticus/venv/bin/pip install --upgrade pip \
    && /opt/chatticus/venv/bin/pip install /opt/chatticus/src \
        boto3 httpx fastapi 'pydantic>=2' python-dotenv

ENV PATH="/opt/chatticus/venv/bin:${PATH}"

COPY computer/entrypoint.sh /usr/local/bin/chatticus-computer-entrypoint
RUN chmod +x /usr/local/bin/chatticus-computer-entrypoint \
    && mkdir -p /var/lib/chatticus/computer/workspace \
        /var/lib/chatticus/computer/browser-profile \
        /var/lib/chatticus/store

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/chatticus-computer-entrypoint"]
CMD ["sleep", "infinity"]
