# Dockerfile for ThingsBoard Auth Bridge
FROM node:22-slim

# Install ttyd, cloudflared, and SSH client
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    openssh-client \
    && wget -qO /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd \
    && wget -qO /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code and UI
COPY server.js login.html login_wrapper.sh entrypoint.sh ./
RUN chmod +x login_wrapper.sh entrypoint.sh

# Environment variables (defaults)
ENV TB_SERVER=https://tb.piltismart.com
ENV TTYD_PORT=7681
ENV BRIDGE_PORT=3000
ENV SSH_HOST=172.17.0.1
ENV SS