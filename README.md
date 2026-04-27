# ThingsBoard SSH & Web Gatekeeper

A secure, zero-config remote access bridge that protects any service (SSH, Web Apps, APIs) using ThingsBoard JWT Authentication via Cloudflare Tunnels.

## 🚀 Features
*   **Universal Gatekeeper**: Protect any port with ThingsBoard Login or expose it publicly.
*   **Zero-Config Networking**: Works behind NAT via Cloudflare Quick Tunnels (no port forwarding).
*   **Dynamic Scaling**: Add or remove protected ports via a single environment variable.
*   **Rich Proxmox Integration**: Automatically updates Proxmox container notes with URLs and metadata in JSON format.
*   **Build Once, Deploy Many**: Host-independent architecture; works on any Proxmox node or Linux server.

---

## 🛠️ Installation (Proxmox Host)

### Step 1: Prepare the Host Polling Script
This script discovers running bridges and updates the Proxmox "Notes" section with the access URLs.

1.  SSH into your Proxmox Host.
2.  Create the script:
    ```bash
    cat << 'EOF' > /usr/local/bin/update-bridge-notes.sh
    #!/bin/bash
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    PCT=/usr/sbin/pct
    RUNNING_VMS=$($PCT list | awk 'NR>1 && $2=="running" {print $1}')
    for VMID in $RUNNING_VMS; do
        URL=$($PCT exec $VMID -- cat /app/tmp/tunnel_url 2>/dev/null)
        if [ -n "$URL" ]; then
            $PCT set $VMID --description "$URL"
        fi
    done
    EOF
    chmod +x /usr/local/bin/update-bridge-notes.sh
    ```
3.  Add to Crontab (runs every minute):
    ```bash
    (crontab -l 2>/dev/null; echo "* * * * * /usr/local/bin/update-bridge-notes.sh") | crontab -
    ```

---

## 📦 Deployment (Inside LXC)

### Step 1: Configuration (`docker-compose.yml`)
The core of the system is the `EXPOSE_PORTS` variable. Use the format: `EXTERNAL_PORT:MODE:INTERNAL_PORT`.

*   **MODE**: `private` (Requires ThingsBoard Login) or `public` (Bypasses Login).
*   **INTERNAL_PORT**: `7681` for the built-in terminal, or any port on the LXC host.

```yaml
services:
  tb-gatekeeper:
    image: piltismartsolutions/tb-ssh-bridge:latest
    environment:
      - TB_SERVER=https://tb.piltismart.com
      - SSH_HOST=172.17.0.1
      # Configuration Example:
      # Port 3000 -> Private access to SSH (7681)
      # Port 80   -> Public access to Web App (80)
      - EXPOSE_PORTS=3000:private:7681, 80:public:80
    volumes:
      - ./tmp:/tmp
    restart: always
```

### Step 2: Start the Stack
```bash
docker compose up -d
```

---

## 📊 Proxmox Notes (Rich JSON)
Once running, check your Proxmox container **Notes**. You will see a structured JSON object:

```json
{
  "last_updated": "2026-04-27T13:46:17Z",
  "services": {
    "3000": {
      "url": "https://denmark-buses-aimed-gently.trycloudflare.com",
      "access": "private",
      "target": "7681"
    },
    "80": {
      "url": "https://suburban-athena-lib-inappropriate.trycloudflare.com",
      "access": "public",
      "target": "80"
    }
  }
}
```

---

## ⚙️ Configuration Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `TB_SERVER` | Your ThingsBoard URL | `https://tb.piltismart.com` |
| `SSH_HOST` | The LXC Gateway IP | `172.17.0.1` |
| `EXPOSE_PORTS` | Comma-separated `EXT:MODE:INT` list | `3000:private:7681` |

---

## 🛡️ Security
*   **JWT Validation**: Private ports forward to an Auth Bridge that v