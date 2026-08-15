#!/bin/bash
set -e

LXC_ID=100
LXC_TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"

echo "Creating LXC $LXC_ID (Test Server)..."
pct create $LXC_ID $LXC_TEMPLATE --hostname test-server \
  --cores 1 --memory 512 --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=purplevn,ip=10.70.70.10/24,gw=10.70.70.1 \
  --nameserver 8.8.8.8 \
  --unprivileged 1 \
  --password qwer1234 || echo "Container may already exist"

echo "Starting LXC $LXC_ID..."
pct start $LXC_ID

# Wait for network
sleep 5

echo "Installing nginx inside LXC..."
pct exec $LXC_ID -- bash -c 'apt-get update && apt-get install -y nginx && systemctl start nginx'

echo "Test server deployed at 10.70.70.10"
