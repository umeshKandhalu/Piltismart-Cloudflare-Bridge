#!/bin/bash

# Configuration: EXPOSE_PORTS=3000:private:7681,80:public:80,5432:tcp:5432
IFS=',' read -ra PORT_LIST <<< "$EXPOSE_PORTS"

# 1. Start ttyd (terminal engine) in the background if needed
/usr/local/bin/ttyd -W -p 7681 /app/login_wrapper.sh &

# 2. Process each port
echo "Initializing Universal Gatekeeper with TCP Support..."
for ITEM in "${PORT_LIST[@]}"; do
    ITEM=$(echo $ITEM | xargs)
    IFS=':' read -ra PARTS <<< "$ITEM"
    EXT_PORT=${PARTS[0]}
    MODE=${PARTS[1]}
    INT_PORT=${PARTS[2]}
    
    echo "Processing Port $EXT_PORT | Mode: $MODE | Target: $INT_PORT"

    if [ "$MODE" == "public" ]; then
        # PUBLIC: Direct HTTP Tunnel
        /usr/local/bin/cloudflared tunnel --url "http://$SSH_HOST:$INT_PORT" > "/tmp/tunnel_$EXT_PORT.log" 2>&1 &
    elif [ "$MODE" == "tcp" ]; then
        # TCP: Raw TCP Tunnel (for databases)
        echo "[TCP] Starting Raw TCP Tunnel for port $EXT_PORT -> $SSH_HOST:$INT_PORT"
        /usr/local/bin/cloudflared tunnel --url "tcp://$SSH_HOST:$INT_PORT" > "/tmp/tunnel_$EXT_PORT.log" 2>&1 &
    else
        # PRIVATE: Auth Bridge
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
    JSON="{\"last_updated\": \"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\", \"services\": {"
    FIRST=true
    
    for ITEM in "${PORT_LIST[@]}"; do
        ITEM=$(echo $ITEM | xargs)
        IFS=':' read -ra PARTS <<< "$ITEM"
        EXT_PORT=${PARTS[0]}
        MODE=${PARTS[1]}
        INT_PORT=${PARTS[2]}
        
        URL=$(grep -o "https://[-a-z0-9]*.trycloudflare.com" "/tmp/tunnel_$EXT_PORT.log" | head -n 1)
        if [ -n "$URL" ]; then
            if [ "$FIRST" = false ]; then JSON="$JSON, "; fi
            JSON="$JSON\"$EXT_PORT\": {\"url\": \"$URL\", \"access\": \"$MODE\", \"target\": \"$INT_PORT\"}"
            FIRST=false
        else
            FOUND_ALL=false
        fi
    done
    JSON="$JSON}}"
    
    if [ "$FOUND_ALL" = true ]; then
        printf "%s" "$JSON" > /tmp/tunnel_url
        echo "Rich JSON ready: $JSON"
        break
    fi
    sleep 2
done

# Keep script alive
wait
