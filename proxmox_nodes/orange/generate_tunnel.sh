#!/bin/bash
set -e

source .env

if [ -z "$CF_ACCOUNT_ID" ] || [ -z "$CF_API_TOKEN" ]; then
  echo "Missing CF_ACCOUNT_ID or CF_API_TOKEN in .env"
  exit 1
fi

TUNNEL_NAME="orange-gateway-tunnel-$(date +%s)"
# Generate a random 32-byte secret and base64 encode it
TUNNEL_SECRET=$(head -c 32 /dev/urandom | base64)

echo "Creating Cloudflare Tunnel: $TUNNEL_NAME..."
RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
     -H "Authorization: Bearer $CF_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data "{\"name\":\"$TUNNEL_NAME\",\"tunnel_secret\":\"$TUNNEL_SECRET\"}")

SUCCESS=$(echo $RESPONSE | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
  echo "Failed to create tunnel:"
  echo $RESPONSE | jq .
  exit 1
fi

TUNNEL_ID=$(echo $RESPONSE | jq -r '.result.id')
echo "Tunnel created successfully! Tunnel ID: $TUNNEL_ID"

# The token is base64(JSON({a: account_id, t: tunnel_id, s: tunnel_secret}))
JSON_PAYLOAD="{\"a\":\"$CF_ACCOUNT_ID\",\"t\":\"$TUNNEL_ID\",\"s\":\"$TUNNEL_SECRET\"}"
# Base64 encode the JSON payload without newlines
TUNNEL_TOKEN=$(echo -n "$JSON_PAYLOAD" | base64 | tr -d '\n')

echo "Generated TUNNEL_TOKEN: $TUNNEL_TOKEN"

# Update .env
if grep -q "^TUNNEL_TOKEN=" .env; then
  sed -i.bak "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TUNNEL_TOKEN|" .env
else
  echo "TUNNEL_TOKEN=$TUNNEL_TOKEN" >> .env
fi

echo "Updated .env with TUNNEL_TOKEN."
