# Chatticus computer
#
# Long-lived Linux workplace. Same image on Fargate, EC2, and local Docker.
# Not a Lambda runtime. Build from the repository root:
#   docker build -f computer/Dockerfile -t chatticus-computer .

# Debian Chromium is a real deb (Ubuntu's chromium-browser is a snap stub).
# Official python:3.12 is required: bookworm's python3 is 3.11 and chatticus
# declares requires-python >=3.12.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CHATTICUS_LIVE_ROOT=/var/lib/chatticus/computer \
    CHATTICUS_SNAPSHOT_STORE=/var/lib/chatticus/store

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    chromium \
    fonts-liberation \
    ca-certificates \
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
        /var/lib/chatticus/computer/browser-profiles/untrusted \
        /var/lib/chatticus/computer/browser-profiles/privileged \
        /var/lib/chatticus/store

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/chatticus-computer-entrypoint"]
CMD ["sleep", "infinity"]
