#!/bin/bash

echo "========================================================="
echo " PiltiSmart Cloudflare Gateway - Proxmox Ingress Controller"
echo "========================================================="

if [ -z "$CF_API_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; then
    echo "[ERROR] CF_API_TOKEN and CF_ACCOUNT_ID environment variables are required for Autonomous Mode!"
    exit 1
fi

# 1. Start ttyd (terminal engine) in the background if needed
/usr/local/bin/ttyd -W -p 7681 /app/login_wrapper.sh &

# 2. Start the Node.js Gateway Manager 
# (This will autonomously create/manage the tunnel, handle webhooks, and start cloudflared)
echo "Starting Autonomous Gateway Manager..."
node server.js &

# Keep script alive
wait
