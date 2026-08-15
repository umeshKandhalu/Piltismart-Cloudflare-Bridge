#!/bin/bash
set -e

LXC_ID=999
LXC_TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"

echo "Downloading Ubuntu 22.04 template if not exists..."
pveam update
pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst || true

echo "Creating LXC $LXC_ID..."
pct create $LXC_ID $LXC_TEMPLATE --hostname piltismart-gateway \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=orangevn,ip=10.20.20.2/24,gw=10.20.20.1 \
  --nameserver 8.8.8.8 \
  --features nesting=1 \
  --unprivileged 1 \
  --password qwer1234 || echo "Container may already exist"

echo "Starting LXC $LXC_ID..."
pct start $LXC_ID

# Wait for network
sleep 5

echo "Installing Docker inside LXC..."
pct exec $LXC_ID -- bash -c 'apt-get update && apt-get install -y curl git && curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh'

pct exec $LXC_ID -- bash -c 'git clone https://github.com/umeshKandhalu/Piltismart-Cloudflare-Bridge.git /opt/gateway'

echo "Copying config files into LXC..."
pct push $LXC_ID ./docker-compose.yml /opt/gateway/docker-compose.yml
pct push $LXC_ID ./.env /opt/gateway/.env

echo "Deploying Gateway container..."
pct exec $LXC_ID -- bash -c 'cd /opt/gateway && docker compose up -d'

echo "Gateway Deployment Completed!"
