#!/bin/bash
set -e

# Dynamic VMID and IP assignment with fallback
LXC_ID=${1:-${LXC_ID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 100)}}
IP=${2:-${IP:-"10.70.70.10"}}
VNET=${3:-${VNET:-"purplevn"}}
GW=${4:-${GW:-"10.70.70.1"}}
LXC_TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"

echo "Creating LXC $LXC_ID (Test Server) with IP $IP on $VNET..."
pct create $LXC_ID $LXC_TEMPLATE --hostname test-server-$LXC_ID \
  --cores 1 --memory 512 --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=$VNET,ip=$IP/24,gw=$GW \
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
