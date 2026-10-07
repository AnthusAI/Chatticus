FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY dist/ /app/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
	&& mkdir -p /workspace \
	&& chown node:node /workspace

USER node
WORKDIR /workspace
ENV SPIKE_WORKSPACE=/workspace
ENTRYPOINT ["/app/entrypoint.sh"]
