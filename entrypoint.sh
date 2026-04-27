#!/bin/bash

# Configuration: EXPOSE_PORTS=3000:private:7681,80:public:80
IFS=',' read -ra PORT_LIST <<< "$EXPOSE_PORTS"

# 1. Start ttyd (terminal engine) in the background if needed
/usr/local/bin/ttyd -W -p 7681 /app/login_wrapper.sh &

# 2. Process each port
echo "Initializing Universal Gatekeeper with Rich Metadata..."
for ITEM in "${PORT_LIST[@]}"; do
    ITEM=$(echo $ITEM | xargs)
    IFS=':' read -ra PARTS <<< "$ITEM"
    EXT_PORT=${PARTS[0]}
    MODE=${PARTS[1]}
    INT_PORT=${PARTS[2]}
    
    if [ "$MODE" == "public" ]; then
        /usr/local/bin/cloudflared tunnel --url "http://$SSH_HOST:$INT_PORT" > "/tmp/tunnel_$EXT_PORT.log" 2>&1 &
    else
        T_HOST="localhost"
        if [ "$INT_PORT" != "7681" ]; then T_HOST="$SSH_HOST"; fi
        BRIDGE_PORT=$EXT_PORT TARGET_PORT=$INT_PORT TARGET_HOST=$T_HOST node server.js &
        /usr/local/bin/cloudflared tunnel --url "http://localhost:$EXT_PORT" > "/tmp/tunnel_$EXT_PORT.log" 2>&1 &
    fi
done

# 3. Wait for URLs and generate RICH JSON for Proxmox Notes
echo "Waiting for Cloudflare URLs..."
for i in {1..30}; do
    FOUND_ALL=true
    JSON="{\"last_updated\": \"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\"