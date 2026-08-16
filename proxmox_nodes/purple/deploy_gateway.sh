#!/bin/bash
set -e

LXC_ID=999
LXC_TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"

echo "Downloading Ubuntu 22.04 template if not exists..."
pveam update
pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst || true

echo "Creating LXC $LXC_ID..."
pct create $LXC_ID $LXC_TEMPLATE --hostname purple-gateway \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=purplevn,ip=10.70.70.2/24,gw=10.70.70.1 \
  --nameserver 8.8.8.8 \
  --features nesting=1 \
  --unprivileged 1 \
  --password qwer1234 || echo "Container may already exist"

echo "Configuring /dev/net/tun for Tailscale subnet routing..."
if ! grep -q "lxc.cgroup2.devices.allow: c 10:200 rwm" /etc/pve/lxc/$LXC_ID.conf; then
  echo "lxc.cgroup2.devices.allow: c 10:200 rwm" >> /etc/pve/lxc/$LXC_ID.conf
  echo "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file" >> /etc/pve/lxc/$LXC_ID.conf
fi

echo "Starting LXC $LXC_ID..."
pct start $LXC_ID || echo "CT $LXC_ID already running"

# Wait for network
sleep 5

echo "Installing Docker inside LXC..."
pct exec $LXC_ID -- bash -c 'apt-get update && apt-get install -y curl git && curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh'

echo "Installing Tailscale inside LXC..."
pct exec $LXC_ID -- bash -c 'curl -fsSL https://tailscale.com/install.sh | sh'

pct exec $LXC_ID -- bash -c 'rm -rf /opt/gateway && git clone https://github.com/umeshKandhalu/Piltismart-Cloudflare-Bridge.git /opt/gateway'

echo "Copying .env file into LXC..."
if [ -f "./.env" ]; then
  pct push $LXC_ID ./.env /opt/gateway/.env
else
  echo "[WARNING] .env file not found in current directory! Gateway container might fail to start."
fi

echo "Deploying Gateway container..."
pct exec $LXC_ID -- bash -c 'cd /opt/gateway && docker compose up -d --build'

echo "Gateway Deployment Completed!"
