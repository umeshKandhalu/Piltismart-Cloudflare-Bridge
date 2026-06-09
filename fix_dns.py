import os, json, requests

env_file = ".env"
with open(env_file) as f:
    env = dict(line.strip().split("=", 1) for line in f if "=" in line)

token = env.get("CF_API_TOKEN")
zone_id = env.get("CF_ZONE_ID")

# The tunnel ID we found on the server
tunnel_id = "679587f0-e109-4dfd-a1de-a949f0004809"
target = f"{tunnel_id}.cfargotunnel.com"
hostname = "admin-gold-gateway.piltismart.com"

headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?name={hostname}"

r = requests.get(url, headers=headers)
records = r.json().get("result", [])

if records:
    rec_id = records[0]["id"]
    put_url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rec_id}"
    data = {"type": "CNAME", "name": hostname, "content": target, "proxied": True}
    requests.put(put_url, headers=headers, json=data)
    print(f"Updated {hostname} to {target}")
else:
    print("Not found")

