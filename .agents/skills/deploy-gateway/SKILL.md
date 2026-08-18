---
name: deploy-gateway
description: >-
  Guide and runbook for deploying, configuring, and verifying the PiltiSmart Cloudflare Bridge Gateway LXC container, dynamic sample test servers (LXC/VM), and teardown procedures on Proxmox VE nodes. Use whenever the user asks to deploy, setup, test, clean up, or troubleshoot the gateway and associated test instances.
---

# PiltiSmart Gateway Deployment & Testing Runbook

This skill provides step-by-step procedures for deploying the central **PiltiSmart Cloudflare Bridge Gateway** on a Proxmox VE host node (e.g., `orange`, `purple`, `gold`), dynamically provisioning **sample test servers (LXC & VM)** based on cluster availability, and **cleaning up/removing test servers** after verification.

---

## 1. Prerequisites Checklist

Before initiating deployment on the Proxmox host:

1. **Host Access**: Root / sudo shell access on the Proxmox VE host.
2. **Environment File (`.env`)**: Ensure the `.env` file exists in the target node directory (e.g., `proxmox_nodes/<node_name>/.env`) with:
   - `CF_ACCOUNT_ID` - Cloudflare Account ID
   - `CF_API_TOKEN` - Cloudflare API Token (with Tunnel & DNS Edit permissions)
   - `CF_ZONE_ID` - Target Cloudflare DNS Zone ID
   - `BASE_DOMAIN` - Base domain (e.g., `piltismart.com`)
   - `API_KEY` - Secure backend API key
   - `TB_SERVER` - ThingsBoard URL (optional / if enabled)
   - `TUNNEL_TOKEN` - (Will be populated by `generate_tunnel.sh` or manually)
3. **Proxmox SDN**: Software-Defined Networking support installed on Proxmox.

---

## 2. Gateway Deployment Workflow

Execute the deployment following this sequential workflow:

### Step 1: Configure Software-Defined Network (SDN)

Ensure the internal private SDN zone, VNet, and subnet with SNAT are created on the Proxmox node.

```bash
# Run on the Proxmox host inside the node folder
cd /path/to/proxmox_nodes/<node_name>
chmod +x setup_sdn.sh
./setup_sdn.sh
```

**Verification**:
```bash
pvesh get /cluster/sdn/vnets
```

---

### Step 2: Generate Cloudflare Tunnel Token (if needed)

If a `TUNNEL_TOKEN` is not already configured in `.env`, generate one automatically:

```bash
chmod +x generate_tunnel.sh
./generate_tunnel.sh
```

This script:
- Queries the Cloudflare API to create a new Tunnel (`<node>-gateway-tunnel-<timestamp>`).
- Encodes the credentials into a single Base64 `TUNNEL_TOKEN`.
- Writes/updates `TUNNEL_TOKEN` into the local `.env` file.

---

### Step 3: Deploy the Gateway LXC Container

Run the deployment script to create and launch the LXC container (default LXC ID: `999`):

```bash
chmod +x deploy_gateway.sh
./deploy_gateway.sh
```

#### What `deploy_gateway.sh` executes:
1. Downloads the standard Ubuntu template (`ubuntu-22.04-standard` or latest) if not present.
2. Creates the LXC container (`pct create`) with:
   - `nesting=1` (required for Docker inside LXC)
   - `unprivileged=1`
   - Static IP assigned on the SDN bridge (e.g., `10.20.20.2/24` or node subnet)
3. Injects `/dev/net/tun` device passthrough in `/etc/pve/lxc/<LXC_ID>.conf` for Tailscale subnet routing:
   ```text
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   ```
4. Starts the container (`pct start <LXC_ID>`).
5. Installs Docker and Tailscale inside the container.
6. Clones `Piltismart-Cloudflare-Bridge` to `/opt/gateway`.
7. Pushes `.env` into the container (`/opt/gateway/.env`).
8. Builds and starts the gateway container (`docker compose up -d --build`).

---

## 3. Dynamic Sample Test Servers Provisioning

### Discovering Available VMIDs and Subnet IPs

Before deploying a test server, discover free VMIDs and available IP addresses dynamically:

```bash
# 1. Query Proxmox for the next available VMID in the cluster
TEST_VMID=$(pvesh get /cluster/nextid)
echo "Next available VMID: $TEST_VMID"

# 2. Check currently used VMIDs and container names
pct list
qm list

# 3. Choose an available IP within your node's SDN subnet
# e.g., orangevn subnet: 10.20.20.0/24 (Gateway: 10.20.20.2, Subnet: 10.20.20.10 - 10.20.20.254)
# e.g., purplevn subnet: 10.70.70.0/24 (Gateway: 10.70.70.2, Subnet: 10.70.70.10 - 10.70.70.254)
TEST_IP="10.20.20.15"
```

---

### Option A: Deploy Sample Test LXC Container (Nginx)

The script accepts dynamic parameters: `./deploy_test_server.sh [LXC_ID] [IP] [VNET] [GATEWAY]` or environment variables. If omitted, it automatically calls `pvesh get /cluster/nextid`.

```bash
chmod +x deploy_test_server.sh

# Method 1: Automatic next ID with custom IP
./deploy_test_server.sh "$TEST_VMID" "10.20.20.15"

# Method 2: Environment variables
LXC_ID=105 IP=10.20.20.25 ./deploy_test_server.sh

# Method 3: Fully automated defaults (uses next available VMID & default test IP)
./deploy_test_server.sh
```

---

### Option B: Deploy Sample Test Cloud-Init VM (Nginx + QEMU Agent)

The VM script also accepts dynamic parameters: `./deploy_test_vm.sh [VMID] [IP] [VNET] [GATEWAY]` or environment variables.

```bash
chmod +x deploy_test_vm.sh

# Method 1: Specific VMID and IP
./deploy_test_vm.sh "$TEST_VMID" "10.20.20.30"

# Method 2: Environment variables
VMID=106 IP=10.20.20.35 ./deploy_test_vm.sh

# Method 3: Automated defaults
./deploy_test_vm.sh
```

---

### Step 4: Register Dynamic Test Server with Gateway

Register the dynamically allocated test instance via the Gateway REST API (`/register`):

```bash
# Register test server with its actual VMID and IP
curl -X POST http://127.0.0.1:5000/register \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "vmid": '"$TEST_VMID"',
    "hostname": "test-server-'"$TEST_VMID"'",
    "ip": "'"$TEST_IP"'",
    "envType": "lxc",
    "expose": [
      { "port": 80, "mode": "public" },
      { "port": 22, "mode": "tcp", "idleTimeout": 30 }
    ]
  }'
```

---

## 4. End-to-End Verification & Health Checks

1. **Check Registered Services Status**:
   ```bash
   pct exec 999 -- curl -s http://127.0.0.1:5000/services -H "x-api-key: <API_KEY>" | jq .
   ```
2. **Verify Public Cloudflare URL**:
   Test accessing the generated public hostname in browser or via curl:
   ```bash
   curl -I https://pb80-<node>-${TEST_VMID}-test-server-${TEST_VMID}.<BASE_DOMAIN>
   ```
3. **Verify Beszel Agent Monitoring (Optional)**:
   Deploy Beszel to the test server:
   ```bash
   pct exec 999 -- curl -X POST http://127.0.0.1:5000/api/beszel/register \
     -H "Content-Type: application/json" \
     -H "x-api-key: <API_KEY>" \
     -d '{"vmid": '"$TEST_VMID"'}'
   ```

---

## 5. Teardown / Cleanup of Test Servers

Once testing is complete and the setup is verified working, remove the test servers and their routes using the specific `$TEST_VMID`:

### 1. Remove Routes from Gateway & Cloudflare
Unregister the test routes through the Gateway API (or Dashboard):
```bash
curl -X POST http://127.0.0.1:5000/unregister \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"vmid": '"$TEST_VMID"'}'
```

### 2. Remove Sample Test LXC Container
```bash
# Stop and destroy container
pct stop $TEST_VMID || true
pct destroy $TEST_VMID --purge 1
```

### 3. Remove Sample Test VM
```bash
# Stop and destroy VM
qm stop $TEST_VMID || true
qm destroy $TEST_VMID --purge 1 --destroy-unreferenced-disks 1

# Optional: Clean up cloud-init snippets
rm -f /var/lib/vz/snippets/user-data.yaml
```

---

## 6. Troubleshooting Common Issues

| Issue | Cause | Resolution |
| :--- | :--- | :--- |
| **VMID Conflict / Already in use** | Hardcoded ID already assigned to another VM/CT | Use `pvesh get /cluster/nextid` to fetch the next free ID automatically. |
| **IP Address Conflict** | Multiple instances assigned same static IP | Verify assigned IPs on node via `pct list` / `qm list` and pick an unused IP in the SDN subnet range. |
| **Docker fails to start inside Gateway LXC** | Nesting or keyctl not enabled in LXC configuration | Ensure `features: nesting=1,keyctl=1` exists in `/etc/pve/lxc/999.conf`. |
| **Tailscale / TUN errors** | `/dev/net/tun` not passed through | Verify `lxc.cgroup2.devices.allow: c 10:200 rwm` and `lxc.mount.entry: /dev/net/tun ...` in `/etc/pve/lxc/999.conf`, then restart LXC (`pct reboot 999`). |
| **Tunnel Degraded / Auth Failed** | Invalid or missing `TUNNEL_TOKEN` or `CF_API_TOKEN` | Check `.env` values and re-run `./generate_tunnel.sh`. Check Cloudflare Zero Trust Dashboard under Access > Tunnels. |
| **Test Server Not Reachable** | SDN gateway / subnet misconfiguration | Verify `setup_sdn.sh` applied SNAT (`--snat 1`) and `pvesh set /cluster/sdn` was run. Ensure both test server and Gateway are on the same SDN VNet (`orangevn` / `purplevn`). |
| **Missing .env in container** | `.env` was missing on host prior to deploy | Create `.env` from template, push manually: `pct push 999 ./.env /opt/gateway/.env` and restart Docker (`pct exec 999 -- bash -c 'cd /opt/gateway && docker compose restart'`). |
