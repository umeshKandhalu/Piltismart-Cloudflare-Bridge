const express = require('express');
const axios = require('axios');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

// Environment Variables
const TB_SERVER = process.env.TB_SERVER || 'https://tb.piltismart.com';
const ADMIN_PORT = process.env.ADMIN_PORT || 5000;
const PROXY_PORT = process.env.PROXY_PORT || 8080;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const BASE_DOMAIN = process.env.BASE_DOMAIN;
const CLUSTER_NAME = process.env.CLUSTER_NAME || 'piltismart-proxmox';

// Proxmox Variables
const PVE_URL = process.env.PVE_URL;
const PVE_NODE = process.env.PVE_NODE;
const PVE_USER = process.env.PVE_USER;
const PVE_PASSWORD = process.env.PVE_PASSWORD;
const https = require('https');

const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !BASE_DOMAIN || !GATEWAY_API_KEY) {
    console.error("[Gateway] Missing required environment variables: CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, BASE_DOMAIN, GATEWAY_API_KEY");
    process.exit(1);
}

const DATA_DIR = '/data';
if (!fs.existsSync(DATA_DIR)) {
    console.warn(`[Gateway] Warning: Persistent volume ${DATA_DIR} is missing. State will be lost on restart.`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');

// In-Memory State
let routes = {}; // hostname -> { target, mode, vmid, status, lastChecked }
let sessions = {}; // Holds authenticated dashboard users
let auditLogs = [];
if (fs.existsSync(STATE_FILE)) {
    try {
        const rawRoutes = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const [key, val] of Object.entries(rawRoutes)) {
            const lKey = key.toLowerCase();
            routes[lKey] = val;
            if (!routes[lKey].metrics) routes[lKey].metrics = { requests: 0, bytesRx: 0, bytesTx: 0 };
            if (routes[lKey].latency === undefined) routes[lKey].latency = -1;
            if (!routes[lKey].createdAt) routes[lKey].createdAt = new Date().toISOString();
        }
        console.log(`[Gateway] Loaded ${Object.keys(routes).length} existing routes from persistent state.`);
    } catch (e) {
        console.error("[Gateway] Failed to parse existing state file. Starting fresh.");
    }
}

// Embedded Web Terminal State (ttyd)
const ttydInstances = {}; // hostname -> { port, proc }
let nextTtydPort = 8100;

function startTtyd(hostname, targetIp) {
    if (ttydInstances[hostname]) return ttydInstances[hostname].port;
    
    const port = nextTtydPort++;
    console.log(`[Gateway] Spawning embedded ttyd for ${hostname} to target ${targetIp} on local port ${port}`);
    
    const cmd = `
echo -e "\\e[36m"
cat << 'EOF'
    ____  ______  _______________ __  ______    ____  ______
   / __ \\/  _/ / /_  __/  _/ ___//  |/  /   |  / __ \\/_  __/
  / /_/ // // /   / /  / / \\__ \\/ /|_/ / /| | / /_/ / / /   
 / ____// // /___/ / _/ / ___/ / /  / / ___ |/ _, _/ / /    
/_/   /___/_____/_/ /___//____/_/  /_/_/  |_/_/ |_| /_/     
EOF
echo -e "\\e[0m"
echo -e "\\e[33m=====================================================================\\e[0m"
echo -e "\\e[31m  WARNING: This system is the property of PiltiSmart.\\e[0m"
echo -e "\\e[33m  Unauthorized access, use, or modification of this system\\e[0m"
echo -e "\\e[33m  or of the data contained herein is strictly prohibited.\\e[0m"
echo -e "\\e[33m=====================================================================\\e[0m\\n"

while true; do
  read -p "login as: " user
  if [ -n "$user" ]; then
    exec ssh -o StrictHostKeyChecking=no "$user@${targetIp}"
  fi
done
`;
    const proc = spawn('/usr/local/bin/ttyd', ['-W', '-p', port.toString(), 'bash', '-c', cmd]);
    
    proc.on('error', (err) => {
        console.error(`[Gateway] ttyd error for ${hostname}:`, err);
    });
    
    proc.on('close', (code) => {
        console.log(`[Gateway] ttyd process for ${hostname} exited with code ${code}`);
        delete ttydInstances[hostname];
    });
    
    ttydInstances[hostname] = { port, proc };
    return port;
}

function stopTtyd(hostname) {
    if (ttydInstances[hostname]) {
        console.log(`[Gateway] Killing ttyd process for ${hostname}`);
        try {
            ttydInstances[hostname].proc.kill();
        } catch(e) {}
        delete ttydInstances[hostname];
    }
}

// Native SSH TCP Tunneling State (Pinggy)
const pinggyInstances = {}; // hostname -> { proc }

function startPinggy(hostname, targetIp, port) {
    if (pinggyInstances[hostname]) return;

    console.log(`[Gateway] Spawning Pinggy TCP tunnel for ${hostname} to target ${targetIp}:${port}`);
    const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-p', '443',
        `-R0:${targetIp}:${port}`,
        'tcp@a.pinggy.io'
    ]);

    let urlCaptured = false;

    const parseOutput = (data) => {
        const text = data.toString();
        // Look for tcp://xyz.pinggy.link:port
        const match = text.match(/(tcp:\/\/[a-zA-Z0-9.-]+:\d+)/);
        if (match && !urlCaptured) {
            urlCaptured = true;
            const pinggyUrl = match[1];
            console.log(`[Pinggy] Successfully acquired public TCP endpoint for ${hostname}: ${pinggyUrl}`);
            if (routes[hostname]) {
                routes[hostname].pinggyUrl = pinggyUrl;
                saveState();
            }
        }
    };

    proc.stdout.on('data', parseOutput);
    proc.stderr.on('data', parseOutput);

    proc.on('error', (err) => {
        console.error(`[Pinggy] Process error for ${hostname}:`, err);
    });

    proc.on('close', (code) => {
        console.log(`[Pinggy] Tunnel process for ${hostname} exited with code ${code}.`);
        delete pinggyInstances[hostname];
        
        // Pinggy free tier times out after 60 mins. Auto-respawn if route still exists and is mode tcp.
        if (routes[hostname] && routes[hostname].mode === 'tcp') {
            console.log(`[Pinggy] Auto-respawning TCP tunnel for ${hostname} in 5 seconds...`);
            setTimeout(() => {
                if (routes[hostname] && routes[hostname].mode === 'tcp') {
                    startPinggy(hostname, targetIp, port);
                }
            }, 5000);
        }
    });

    pinggyInstances[hostname] = { proc };
}

function stopPinggy(hostname) {
    if (pinggyInstances[hostname]) {
        console.log(`[Gateway] Killing Pinggy process for ${hostname}`);
        try {
            pinggyInstances[hostname].proc.kill();
        } catch(e) {}
        delete pinggyInstances[hostname];
    }
    if (routes[hostname]) {
        delete routes[hostname].pinggyUrl;
        saveState();
    }
}

// Bootstrap existing ttyd and pinggy routes
for (const [hostname, route] of Object.entries(routes)) {
    route.activeConnections = 0;
    if (route.target && route.target.endsWith(':22')) {
        startTtyd(hostname, route.target.split(':')[0]);
        if (route.idleTimeout) {
            route.lastActive = Date.now();
        }
    }
    if (route.mode === 'tcp') {
        const [targetIp, port] = route.target.split(':');
        startPinggy(hostname, targetIp, port);
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(routes, null, 2));
}

if (fs.existsSync(AUDIT_FILE)) {
    try {
        auditLogs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    } catch (e) {
        console.warn("[Gateway] Failed to parse audit.json, starting with empty logs.");
    }
}

function logAudit(user, action, details) {
    const entry = {
        timestamp: new Date().toISOString(),
        user: user || "System/Automation",
        action: action,
        details: details
    };
    auditLogs.unshift(entry);
    if (auditLogs.length > 1000) {
        auditLogs.length = 1000;
    }
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLogs, null, 2));
}

const cfAxios = axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` }
});

// --- AUTONOMOUS TUNNEL MANAGER ---

let ACTIVE_TUNNEL_ID = null;
let cloudflaredProcesses = [];

async function setupAutonomousTunnel() {
    if (fs.existsSync(CREDENTIALS_FILE)) {
        try {
            const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
            ACTIVE_TUNNEL_ID = creds.TunnelID;
            console.log(`[Gateway] Found existing tunnel credentials for ID: ${ACTIVE_TUNNEL_ID}`);
            return; // We have a tunnel!
        } catch (e) {
            console.error("[Gateway] Failed to parse credentials.json. Recreating tunnel.");
        }
    }

    console.log(`[Gateway] No existing tunnel found. Creating a new one...`);
    const tunnelName = `gateway-proxmox-${PVE_NODE}-${Date.now().toString().slice(-4)}`;
    console.log(`[CF Tunnel] Creating new tunnel: ${tunnelName}`);
    const tunnelSecret = crypto.randomBytes(32);
    const tunnelSecretBase64 = tunnelSecret.toString('base64');

    try {
        const response = await cfAxios.post(`/accounts/${CF_ACCOUNT_ID}/cfd_tunnel`, {
            name: tunnelName,
            tunnel_secret: tunnelSecretBase64
        });
        
        ACTIVE_TUNNEL_ID = response.data.result.id;
        console.log(`[Gateway] Successfully created new Tunnel via API! ID: ${ACTIVE_TUNNEL_ID}`);

        const creds = {
            AccountTag: CF_ACCOUNT_ID,
            TunnelSecret: tunnelSecretBase64,
            TunnelID: ACTIVE_TUNNEL_ID
        };
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
        
        // Re-assign all URLs to this new tunnel!
        console.log(`[Gateway] Tunnel changed! Re-assigning all existing URLs...`);
        for (const hostname of Object.keys(routes)) {
            await createDnsRecord(hostname); // Update CNAMEs
        }
        await updateTunnelIngress(); // Push ingress rules
        
    } catch (e) {
        console.error(`[Gateway] Critical Error creating Tunnel:`, e.response?.data || e.message);
        process.exit(1);
    }
}

function startCloudflaredReplica(replicaId) {
    console.log(`[Gateway] Starting cloudflared tunnel replica ${replicaId}...`);
    const childProc = spawn('/usr/local/bin/cloudflared', ['tunnel', '--no-autoupdate', 'run', ACTIVE_TUNNEL_ID], {
        env: { ...process.env, TUNNEL_CRED_FILE: CREDENTIALS_FILE }
    });

    childProc.stdout.on('data', (data) => console.log(`[cloudflared-${replicaId}] ${data.toString().trim()}`));
    childProc.stderr.on('data', (data) => console.error(`[cloudflared-${replicaId}] ${data.toString().trim()}`));

    childProc.on('close', (code) => {
        console.error(`[Gateway] cloudflared replica ${replicaId} crashed with code ${code}. Restarting in 5 seconds...`);
        setTimeout(() => startCloudflaredReplica(replicaId), 5000);
    });
    
    return childProc;
}

function startCloudflared() {
    const replicas = parseInt(process.env.TUNNEL_REPLICAS) || 4;
    console.log(`[Gateway] Spawning ${replicas} cloudflared replicas for maximum throughput...`);
    for (let i = 1; i <= replicas; i++) {
        cloudflaredProcesses.push(startCloudflaredReplica(i));
    }
}

// --- CLOUDFLARE ACCESS (SERVICE TOKENS) ---

async function createAccessServiceToken(name, durationDays) {
    console.log(`[CF Access] Creating Service Token: ${name} (${durationDays} days)`);
    // Duration must be in format like "8760h"
    const durationHours = parseInt(durationDays) * 24;
    const res = await cfAxios.post(`/accounts/${CF_ACCOUNT_ID}/access/service_tokens`, {
        name: name,
        duration: `${durationHours}h`
    });
    return res.data.result; // { id, client_id, client_secret }
}

async function revokeAccessServiceToken(tokenId) {
    if (!tokenId) return;
    console.log(`[CF Access] Revoking Service Token: ${tokenId}`);
    try {
        await cfAxios.delete(`/accounts/${CF_ACCOUNT_ID}/access/service_tokens/${tokenId}`);
    } catch(e) {
        console.error(`[CF Access] Failed to revoke token ${tokenId}: ${e.response?.data?.errors?.[0]?.message || e.message}`);
    }
}

async function createAccessApp(hostname) {
    console.log(`[CF Access] Creating Access App for: ${hostname}`);
    const res = await cfAxios.post(`/accounts/${CF_ACCOUNT_ID}/access/apps`, {
        name: `Secure-TCP-${hostname}`,
        domain: hostname,
        type: "self_hosted",
        session_duration: "24h",
        app_launcher_visible: false
    });
    return res.data.result.id;
}

async function deleteAccessApp(appId) {
    if (!appId) return;
    console.log(`[CF Access] Deleting Access App: ${appId}`);
    try {
        await cfAxios.delete(`/accounts/${CF_ACCOUNT_ID}/access/apps/${appId}`);
    } catch(e) {
        console.error(`[CF Access] Failed to delete app ${appId}: ${e.response?.data?.errors?.[0]?.message || e.message}`);
    }
}

async function createAccessPolicy(appId, tokenId) {
    console.log(`[CF Access] Creating Policy for App ${appId} with Token ${tokenId}`);
    await cfAxios.post(`/accounts/${CF_ACCOUNT_ID}/access/apps/${appId}/policies`, {
        name: "Allow Service Token Only",
        decision: "non_identity",
        include: [{ service_token: { token_id: tokenId } }]
    });
}

// --- CLOUDFLARE ROUTING AUTOMATION ---

async function createDnsRecord(hostname) {
    try {
        const existing = await cfAxios.get(`/zones/${CF_ZONE_ID}/dns_records?name=${hostname}`);
        const content = `${ACTIVE_TUNNEL_ID}.cfargotunnel.com`;
        
        if (existing.data.result.length > 0) {
            const record = existing.data.result[0];
            if (record.content === content) {
                console.log(`[CF DNS] Record for ${hostname} already points to correct tunnel.`);
                return;
            }
            // Update existing record
            await cfAxios.put(`/zones/${CF_ZONE_ID}/dns_records/${record.id}`, {
                type: "CNAME",
                name: hostname,
                content: content,
                proxied: true
            });
            console.log(`[CF DNS] Updated CNAME for ${hostname}`);
            return;
        }
        
        // Create new record
        await cfAxios.post(`/zones/${CF_ZONE_ID}/dns_records`, {
            type: "CNAME",
            name: hostname,
            content: content,
            proxied: true
        });
        console.log(`[CF DNS] Created CNAME for ${hostname}`);
    } catch (e) {
        console.error(`[CF DNS] Error configuring DNS for ${hostname}:`, e.response?.data || e.message);
    }
}

async function updateTunnelIngress() {
    try {
        const ingress = [];
        for (const [hostname, data] of Object.entries(routes)) {
            const dataPort = parseInt(data.target.split(':')[1]);
            
            if (data.mode === 'tcp' || data.mode === 'secure_tcp') {
                ingress.push({ hostname: hostname, service: `tcp://${data.target}` });
            } else {
                // All HTTP and SSH (ttyd) routes go through the Express proxy
                ingress.push({ hostname: hostname, service: `http://localhost:${PROXY_PORT}` });
            }
        }
        ingress.push({ service: "http_status:404" });

        await cfAxios.put(`/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${ACTIVE_TUNNEL_ID}/configurations`, {
            config: { ingress }
        });
        console.log(`[CF Tunnel] Pushed Ingress rules to Tunnel ${ACTIVE_TUNNEL_ID}. Total rules: ${ingress.length - 1}`);
    } catch (e) {
        console.error(`[CF Tunnel] Error updating tunnel config:`, e.response?.data || e.message);
    }
}

async function deleteRouteState(hostname) {
    const data = routes[hostname];
    if (!data) return;
    
    stopTtyd(hostname);
    stopPinggy(hostname);
    
    if (data.serviceTokenId) {
        await revokeAccessServiceToken(data.serviceTokenId);
    }
    if (data.accessAppId) {
        await deleteAccessApp(data.accessAppId);
    }
    
    delete routes[hostname];
}

function deployBeszelAgent(vmid, hostname, ip, envType, onData, onExit) {
    if (!vmid || vmid === 0) return;
    
    let pubKey = "";
    const pubKeyPath = '/beszel_data/id_ed25519.pub';
    const privKeyPath = '/beszel_data/id_ed25519';
    if (!fs.existsSync(pubKeyPath) && fs.existsSync(privKeyPath)) {
        try {
            require('child_process').execSync(`ssh-keygen -y -f ${privKeyPath} > ${pubKeyPath}`);
        } catch(e) {
            console.error("[Gateway] Failed to generate Beszel pub key:", e.message);
        }
    }
    
    if (fs.existsSync(pubKeyPath)) {
        pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    } else {
        console.error("[Gateway] Cannot auto-deploy Beszel Agent: Public Key not found.");
        return;
    }

    let hostIP = '';
    try {
        hostIP = new URL(PVE_URL).hostname;
    } catch(e) {
        return;
    }

    const ensureCurl = `if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl || apk add curl || yum install -y curl || dnf install -y curl; fi;`;
    const installCmd = `${ensureCurl} rm -f /etc/systemd/system/beszel-agent.service && curl -sL https://raw.githubusercontent.com/henrygd/beszel/main/supplemental/scripts/install-agent.sh | bash -s -- -p 45876 -k "${pubKey}" --auto-update true`;
    
    let remoteScript = "";
    if (envType === 'qemu') {
        remoteScript = `qm guest exec ${vmid} -- bash -c '${installCmd}'`;
    } else {
        remoteScript = `pct exec ${vmid} -- bash -c '${installCmd}'`;
    }

    const sqlQuery = `DELETE FROM systems WHERE name = '${hostname}' OR host = '${ip}'; INSERT INTO systems (name, host, port, status, info, users, created, updated) VALUES ('${hostname}', '${ip}', '45876', 'pending', '{}', (SELECT json_group_array(id) FROM users), datetime('now'), datetime('now'));`;
    const sqlBase64 = Buffer.from(sqlQuery).toString('base64');

    const sqliteCmd = `echo ${sqlBase64} | base64 -d > /tmp/query.sql && sqlite3 /opt/gateway/beszel_data/data.db < /tmp/query.sql`;
    const restartCmd = `docker restart beszel`;
    const hubSetupCmd = `lxc-attach -n 999 -- bash -c "${sqliteCmd} && ${restartCmd}"`;

    const finalRemoteScript = `${remoteScript} && ${hubSetupCmd}`;

    const finalRemoteScriptB64 = Buffer.from(finalRemoteScript).toString('base64');
    const sshCmd = `echo ${finalRemoteScriptB64} | sshpass -p '${PVE_PASSWORD}' ssh -o StrictHostKeyChecking=no root@${hostIP} "ssh -o StrictHostKeyChecking=no ${PVE_NODE} 'base64 -d | bash'"`;

    if (onData) onData(`[Gateway] Auto-deploying Beszel agent to VMID ${vmid} (Type: ${envType})...\n`);
    console.log(`[Gateway] Auto-deploying Beszel agent to VMID ${vmid} (Type: ${envType})...`);
    
    const proc = spawn('bash', ['-c', sshCmd]);
    
    proc.stdout.on('data', (data) => {
        if(onData) onData(data.toString());
    });
    
    proc.stderr.on('data', (data) => {
        if(onData) onData(data.toString());
    });
    
    proc.on('close', async (code) => {
        if (code !== 0) {
            console.error(`[Gateway] Failed to deploy Beszel agent to VMID ${vmid}`);
            if(onData) onData(`\n[Gateway] Failed to deploy Beszel agent (Exit Code ${code})\n`);
            if(onExit) onExit(code);
        } else {
            console.log(`[Gateway] Successfully deployed Beszel agent to VMID ${vmid}`);
            if(onData) onData(`\n[Gateway] Installation finished. Verifying agent status on ${ip}:45876...\n`);
            
            let isUp = false;
            for (let i = 0; i < 5; i++) {
                try {
                    await new Promise((resolve, reject) => {
                        const s = require('net').createConnection(45876, ip);
                        s.on('connect', () => { s.destroy(); resolve(); });
                        s.on('error', (e) => { s.destroy(); reject(e); });
                        setTimeout(() => { s.destroy(); reject(new Error("timeout")); }, 1000);
                    });
                    isUp = true;
                    break;
                } catch(e) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            
            if (isUp) {
                if(onData) onData(`[Gateway] Verification SUCCESS: Agent is actively listening on ${ip}:45876.\n`);
                if(onExit) onExit(0);
            } else {
                if(onData) onData(`[Gateway] Verification FAILED: Agent is not reachable on ${ip}:45876. Please check firewall or container network.\n`);
                if(onExit) onExit(1);
            }
        }
    });
}

async function registerService(vmid, hostname, ip, exposeArray, force = false, envType = 'lxc') {
    let isFirstRoute = true;
    for (const data of Object.values(routes)) {
        if (data.vmid === vmid) {
            isFirstRoute = false;
            break;
        }
    }

    if ((isFirstRoute || force) && vmid > 0) {
        // Auto-registration disabled per user request
        // deployBeszelAgent(vmid, hostname, ip, envType);
    }

    if (force) {
        // Clear old routes for this VMID from state
        for (const [existingHostname, data] of Object.entries(routes)) {
            if (data.vmid === vmid) {
                await deleteRouteState(existingHostname);
            }
        }
    }

    const generatedUrls = [];
    for (const item of exposeArray) {
        const fullHostname = `${PVE_NODE}-${vmid}-${hostname}.${BASE_DOMAIN}`.toLowerCase();
        let prefix = 'p';
        if (item.mode === 'public') prefix = 'pb';
        else if (item.mode === 'private') prefix = 'pt';
        else if (item.mode === 'tcp') prefix = 'tcp';
        else if (item.mode === 'secure_tcp') prefix = 'stcp';
        
        const uniqueHostname = `${prefix}${item.port}-${fullHostname}`;
        
        if (!force && routes[uniqueHostname]) {
            throw new Error(`Route for port ${item.port} already exists (${uniqueHostname}). Please use Force Overwrite to replace it.`);
        }
        
        routes[uniqueHostname] = {
            target: `${ip}:${item.port}`,
            protocol: item.protocol || 'http',
            mode: item.mode,
            vmid: vmid,
            envType: envType,
            status: 'pending',
            lastChecked: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            latency: -1,
            metrics: { requests: 0, bytesRx: 0, bytesTx: 0 },
            activeConnections: 0
        };
        
        if (item.idleTimeout !== undefined && item.idleTimeout > 0) {
            routes[uniqueHostname].idleTimeout = item.idleTimeout;
            routes[uniqueHostname].lastActive = Date.now();
        }

        if (item.port === 22) {
            startTtyd(uniqueHostname, ip);
        }

        if (item.mode === 'tcp') {
            startPinggy(uniqueHostname, ip, item.port);
        }

        await createDnsRecord(uniqueHostname);
        if (item.mode === 'secure_tcp' && item.validityDays) {
            console.log(`[Gateway] Provisioning Secure TCP for ${uniqueHostname} (Validity: ${item.validityDays} days)`);
            const tokenResult = await createAccessServiceToken(`Token-${uniqueHostname}`, item.validityDays);
            const appId = await createAccessApp(uniqueHostname);
            await createAccessPolicy(appId, tokenResult.id);
            
            routes[uniqueHostname].serviceTokenId = tokenResult.id;
            routes[uniqueHostname].accessAppId = appId;
            
            generatedUrls.push({ 
                port: item.port, 
                url: `https://${uniqueHostname}`, 
                mode: item.mode,
                clientId: tokenResult.client_id,
                clientSecret: tokenResult.client_secret,
                hostname: uniqueHostname
            });
        } else {
            generatedUrls.push({ port: item.port, url: `https://${uniqueHostname}`, mode: item.mode });
        }
    }
    saveState();
    await updateTunnelIngress();
    return generatedUrls;
}

// --- HEALTH CHECK DAEMON ---
function pingTcp(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => { socket.destroy(); resolve('online'); });
        socket.on('timeout', () => { socket.destroy(); resolve('offline'); });
        socket.on('error', () => { resolve('offline'); });
        socket.connect(port, host);
    });
}

let isChecking = false;
setInterval(async () => {
    if (isChecking) {
        console.warn("[Gateway] Previous health check is still running, skipping this interval.");
        return;
    }
    isChecking = true;
    try {
        let stateChanged = false;
        const entries = Object.entries(routes);
        
        await Promise.all(entries.map(async ([hostname, data]) => {
            const [host, port] = data.target.split(':');
            if (host && port) {
                const startPing = Date.now();
                const currentStatus = await pingTcp(host, parseInt(port));
                const latencyMs = currentStatus === 'online' ? Date.now() - startPing : -1;
                
                // Self-Healing IP Tracking
                if (currentStatus === 'offline' && data.vmid) {
                    console.warn(`[Self-Healing] ${hostname} is offline. Checking Proxmox for IP drift...`);
                    try {
                        const details = await discoverLxcDetails(data.vmid);
                        if (details.ip && details.ip !== host) {
                            console.log(`[Self-Healing] IP Drift Detected for VMID ${data.vmid}! Healing: ${host} -> ${details.ip}`);
                            data.target = `${details.ip}:${port}`;
                            data.status = await pingTcp(details.ip, parseInt(port));
                            data.latency = data.status === 'online' ? Date.now() - startPing : -1;
                            stateChanged = true;
                        } else {
                            data.status = 'offline';
                            data.latency = -1;
                        }
                    } catch (e) {
                        data.status = 'offline';
                        data.latency = -1;
                    }
                } else {
                    data.status = currentStatus;
                    data.latency = latencyMs;
                }
                
                data.lastChecked = new Date().toISOString();
            }

            // Ephemeral Idle Timeout Sweep
            if (data.idleTimeout && data.activeConnections === 0) {
                const idleMs = Date.now() - (data.lastActive || Date.now());
                if (idleMs > data.idleTimeout * 60000) {
                    console.log(`[Gateway] Sweeping idle route ${hostname} (inactive for >${data.idleTimeout}m)`);
                    await deleteRouteState(hostname);
                    stateChanged = true;
                    logAudit("System/Automation", "IDLE_TIMEOUT_SWEEP", `Automatically deleted idle route ${hostname}`);
                }
            }
        }));
        
        if (stateChanged) {
            saveState();
            await updateTunnelIngress();
        }
    } catch (err) {
        console.error("[Gateway] Health check loop error:", err.message);
    } finally {
        isChecking = false;
    }
}, 15000);

// --- ADMIN API & SWAGGER (PORT 5000) ---
const adminApp = express();
adminApp.use(express.json());

adminApp.use((req, res, next) => {
    // Allow public access to docs, dashboard UI, login, logout and favicon
    if (req.path === '/' || req.path.startsWith('/docs') || req.path.startsWith('/api-docs') || req.path.startsWith('/dashboard') || req.path === '/login' || req.path === '/logout' || req.path === '/favicon.ico') {
        return next();
    }
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) {
        return res.status(401).json({ error: "Unauthorized: Invalid or missing x-api-key" });
    }

    if (apiKey === GATEWAY_API_KEY) {
        req.user = "System/Automation";
        return next();
    }

    if (sessions[apiKey] && sessions[apiKey].expires > Date.now()) {
        req.user = sessions[apiKey].user;
        return next();
    }

    return res.status(401).json({ error: "Unauthorized: Invalid or missing x-api-key" });
});

const swaggerOptions = {
    swaggerDefinition: {
        openapi: '3.0.0',
        info: { title: 'PiltiSmart Gateway API', version: '1.0.0', description: 'Autonomous Gateway for Proxmox Cloudflare Tunnels' },
        servers: [{ url: '/' }],
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key'
                }
            }
        },
        security: [{ ApiKeyAuth: [] }]
    },
    apis: ['server.js'],
};
adminApp.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerJsdoc(swaggerOptions)));

// --- PROXMOX API CLIENT ---
const pveBaseUrl = PVE_URL ? PVE_URL.replace(/\/api2\/json\/?$/, '') : '';
const pveAxios = axios.create({
    baseURL: pveBaseUrl,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

let pveAuthCookie = null;
let pveCsrfToken = null;

async function getPveTicket() {
    if (pveAuthCookie && pveCsrfToken) return; // Cached

    if (!PVE_URL || !PVE_USER || !PVE_PASSWORD) {
        throw new Error("Missing Proxmox API credentials");
    }

    try {
        console.log(`[PVE] Attempting to get ticket at URL: ${pveBaseUrl}/api2/json/access/ticket with User: ${PVE_USER}`);
        const response = await pveAxios.post('/api2/json/access/ticket', new URLSearchParams({
            username: PVE_USER,
            password: PVE_PASSWORD
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const data = response.data.data;
        pveAuthCookie = `PVEAuthCookie=${data.ticket}`;
        pveCsrfToken = data.CSRFPreventionToken;
        console.log(`[PVE] Successfully authenticated to Proxmox API`);

        // Schedule token refresh before it expires (tickets last 2 hours)
        setTimeout(() => { pveAuthCookie = null; pveCsrfToken = null; }, 1000 * 60 * 60);
    } catch (error) {
        console.error(`[PVE] Failed to get Proxmox ticket:`, error.message);
        if (error.response) {
            console.error(`[PVE] Response:`, error.response.status, error.response.data);
        }
        throw error;
    }
}

async function discoverLxcDetails(vmid) {
    await getPveTicket();
    const headers = { 'Cookie': pveAuthCookie, 'CSRFPreventionToken': pveCsrfToken };

    try {
        // 1. Get Hostname from Config
        const configRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/lxc/${vmid}/config`, { headers });
        const hostname = configRes.data.data.hostname;

        // 2. Get active IP from Interfaces
        const interfacesRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/lxc/${vmid}/interfaces`, { headers });
        const interfaces = interfacesRes.data.data;
        
        let ip = null;
        for (const iface of interfaces) {
            if (iface.name === 'eth0' && iface.inet) {
                ip = iface.inet.split('/')[0]; // Extract IP from "192.168.0.28/24"
                break;
            }
        }

        if (!ip) throw new Error("Could not find active IPv4 address on eth0");

        console.log(`[PVE] Auto-discovered LXC ${vmid}: Hostname=${hostname}, IP=${ip}`);
        return { hostname, ip };
    } catch (e) {
        console.error(`[PVE] Auto-discovery failed for VMID ${vmid}:`, e.response?.data || e.message);
        throw new Error(`Failed to discover container details: ${e.message}`);
    }
}

async function discoverVmDetails(vmid) {
    await getPveTicket();
    const headers = { 'Cookie': pveAuthCookie, 'CSRFPreventionToken': pveCsrfToken };

    try {
        // 1. Get Hostname from Config
        const configRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/qemu/${vmid}/config`, { headers });
        const hostname = configRes.data.data.name || `vm-${vmid}`;

        // 2. Get active IP from QEMU Guest Agent Interfaces
        const interfacesRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/qemu/${vmid}/agent/network-get-interfaces`, { headers });
        const interfaces = interfacesRes.data.data.result;
        
        let ip = null;
        if (interfaces && Array.isArray(interfaces)) {
            for (const iface of interfaces) {
                if (iface.name === 'lo') continue;
                if (iface['ip-addresses']) {
                    for (const ipInfo of iface['ip-addresses']) {
                        if (ipInfo['ip-address-type'] === 'ipv4' && ipInfo['ip-address'] !== '127.0.0.1') {
                            ip = ipInfo['ip-address'];
                            break;
                        }
                    }
                }
                if (ip) break;
            }
        }

        if (!ip) throw new Error("Could not find active IPv4 address from QEMU Guest Agent");

        console.log(`[PVE] Auto-discovered VM ${vmid}: Hostname=${hostname}, IP=${ip}`);
        return { hostname, ip };
    } catch (e) {
        console.error(`[PVE] Auto-discovery failed for VMID ${vmid}:`, e.response?.data || e.message);
        throw new Error(`Failed to discover VM details (Guest Agent may not be running): ${e.message}`);
    }
}

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate against ThingsBoard
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: "Returns session token" }
 *       401: { description: "Invalid credentials" }
 */
adminApp.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    
    try {
        const tbResponse = await axios.post(`${TB_SERVER}/api/auth/login`, { username, password });
        if (tbResponse.status === 200 && tbResponse.data.token) {
            const signature = crypto.createHmac('sha256', GATEWAY_API_KEY).update(username).digest('hex');
            const localToken = `${username}:${signature}`;
            sessions[localToken] = {
                user: username,
                expires: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
            };
            logAudit(username, 'LOGIN', 'User successfully authenticated via ThingsBoard');
            res.json({ success: true, token: localToken, user: username });
        }
    } catch (e) {
        const errorReason = e.response?.data?.message || e.response?.statusText || e.message;
        console.error(`[Gateway] ThingsBoard login failed for ${username}: ${errorReason}`);
        logAudit(username || 'Unknown', 'LOGIN_FAILED', `TB Auth Failed: ${errorReason}`);
        res.status(401).json({ error: `Login failed: ${errorReason}` });
    }
});

/**
 * @swagger
 * /logout:
 *   post:
 *     summary: Invalidate user session
 *     tags: [Auth]
 *     security:
 *       - ApiKeyAuth: []
 */
adminApp.post('/logout', (req, res) => {
    // Note: since /logout is public in the path bypass, we check headers manually
    const providedKey = req.headers['x-api-key'];
    if (providedKey && sessions[providedKey]) {
        const user = sessions[providedKey].user;
        logAudit(user, 'LOGOUT', `User ${user} successfully logged out of the dashboard.`);
        delete sessions[providedKey];
    }
    res.json({ success: true });
});

/**
 * @swagger
 * /audit:
 *   get:
 *     summary: Retrieve audit logs
 *     tags: [Gateway]
 *     responses:
 *       200: { description: "List of audit logs" }
 */
adminApp.get('/audit', (req, res) => {
    res.json(auditLogs);
});

/**
 * @swagger
 * /register:
 *   post:
 *     summary: Register a new LXC container and automate its routes
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               vmid: { type: integer, description: "Proxmox Container ID" }
 *               override: { type: boolean, description: "If true, overwrites any existing URLs for this VMID." }
 *               hostname: { type: string, description: "Optional. Will be auto-discovered via Proxmox API if omitted." }
 *               ip: { type: string, description: "Optional. Will be auto-discovered via Proxmox API if omitted." }
 *               expose:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     port: { type: integer }
 *                     mode: { type: string, enum: ["public", "private", "tcp"] }
 *           examples:
 *             ZeroTouchRegistration:
 *               summary: Auto-discover IP & Hostname
 *               value:
 *                 vmid: 101
 *                 expose:
 *                   - port: 11434
 *                     mode: "public"
 *             ManualOverride:
 *               summary: Manually provide IP & Hostname
 *               value:
 *                 vmid: 101
 *                 hostname: "custom-name"
 *                 ip: "192.168.0.50"
 *                 expose:
 *                   - port: 8080
 *                     mode: "private"
 *             ForceOverwrite:
 *               summary: Force overwrite existing URLs
 *               value:
 *                 vmid: 101
 *                 override: true
 *                 expose:
 *                   - port: 11434
 *                     mode: "public"
 *     responses:
 *       200: { description: "Successfully registered" }
 *       500: { description: "Auto-discovery failed" }
 */
adminApp.post('/register', async (req, res) => {
    let { vmid, hostname, ip, expose, force, envType } = req.body;
    envType = envType || 'lxc';
    
    // Strict Payload Validation
    if (typeof vmid !== 'number' || vmid < 0) {
        return res.status(400).json({ error: "Invalid payload: 'vmid' must be a non-negative integer (0 for host)." });
    }
    if (!expose || !Array.isArray(expose) || expose.length === 0) {
        return res.status(400).json({ error: "Invalid payload: 'expose' must be a non-empty array." });
    }

    const seenPorts = new Set();
    for (const item of expose) {
        if (!item.port || typeof item.port !== 'number' || item.port <= 0 || item.port > 65535) {
            return res.status(400).json({ error: `Invalid port: ${item.port}` });
        }
        if (!['public', 'private', 'tcp', 'secure_tcp'].includes(item.mode)) {
            return res.status(400).json({ error: `Invalid mode: ${item.mode} for port ${item.port}. Must be 'public', 'private', 'tcp', or 'secure_tcp'.` });
        }
        if (item.protocol && !['http', 'https'].includes(item.protocol)) {
            return res.status(400).json({ error: `Invalid protocol: ${item.protocol} for port ${item.port}. Must be 'http' or 'https'.` });
        }
        if (seenPorts.has(item.port)) {
            return res.status(400).json({ error: `Duplicate port detected in payload: ${item.port}. A port can only be exposed once per container.` });
        }
        seenPorts.add(item.port);
    }

    if (!hostname || !ip) {
        if (vmid === 0) {
            return res.status(400).json({ error: "For Host routing (vmid 0), 'hostname' and 'ip' must be explicitly provided in the payload." });
        }
        try {
            console.log(`[Gateway] Auto-discovering details for VMID ${vmid} (Type: ${envType})...`);
            let details;
            if (envType === 'qemu') {
                details = await discoverVmDetails(vmid);
            } else {
                details = await discoverLxcDetails(vmid);
            }
            hostname = hostname || details.hostname;
            ip = ip || details.ip;
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }


    try {
        const urls = await registerService(vmid, hostname, ip, expose, !!force, envType);
        logAudit(req.user, 'REGISTER_SERVICE', `Registered route(s) for VMID ${vmid} (${hostname}): ${urls.map(u => u.url).join(', ')}`);
        res.json({ message: "Registered successfully", urls });
    } catch (e) {
        res.status(409).json({ error: e.message });
    }
});

/**
 * @swagger
 * /discover/{vmid}:
 *   get:
 *     summary: Discover Proxmox container IP and Hostname
 *     parameters:
 *       - in: path
 *         name: vmid
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Container details" }
 *       404: { description: "Container not found" }
 */
adminApp.get('/discover/:vmid', async (req, res) => {
    const vmid = parseInt(req.params.vmid);
    if (!vmid) return res.status(400).json({ error: "Invalid VMID" });
    
    try {
        // Try QEMU first
        try {
            const details = await discoverVmDetails(vmid);
            return res.json({ ...details, envType: 'qemu' });
        } catch (qemuErr) {
            // Fallback to LXC
            const details = await discoverLxcDetails(vmid);
            return res.json({ ...details, envType: 'lxc' });
        }
    } catch (e) {
        console.error("[Gateway] Discovery failed for VMID", vmid, e.message);
        if (e.response) {
            console.error("[Gateway] Proxmox Response:", e.response.status, e.response.data);
        }
        res.status(404).json({ error: "Could not auto-discover VM or LXC details." });
    }
});

/**
 * @swagger
 * /api/beszel/register:
 *   post:
 *     summary: Manually deploy Beszel agent to a VM/LXC
 *     tags: [Monitoring]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               vmid: { type: integer }
 *     responses:
 *       200: { description: "Success" }
 *       500: { description: "Error" }
 */
adminApp.post('/api/beszel/register', async (req, res) => {
    try {
        const { vmid } = req.body;
        if (!vmid) return res.status(400).json({ error: "Missing vmid" });
        
        let details;
        let envType;
        try {
            details = await discoverVmDetails(vmid);
            envType = 'qemu';
        } catch(qemuErr) {
            details = await discoverLxcDetails(vmid);
            envType = 'lxc';
        }

        if (!details || !details.hostname || !details.ip) {
            return res.status(404).json({ error: "Could not discover VM details" });
        }
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(`Starting deployment for VMID ${vmid}...\n`);
        
        deployBeszelAgent(vmid, details.hostname, details.ip, envType, 
            (data) => {
                res.write(data);
            },
            (code) => {
                res.write(`\nDeployment process exited with code ${code}.\n`);
                res.end();
            }
        );
        
    } catch (e) {
        console.error("[Gateway] Manual Beszel deploy error:", e);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        } else {
            res.write(`\nError: ${e.message}\n`);
            res.end();
        }
    }
});

/**
 * @swagger
 * /api/beszel/system/{name}:
 *   delete:
 *     summary: Delete a Beszel system directly from PocketBase by name
 *     tags: [Monitoring]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200: { description: "Success" }
 *       500: { description: "Error" }
 */
adminApp.delete('/api/beszel/system/:name', async (req, res) => {
    try {
        const sysName = req.params.name;
        if (!sysName) return res.status(400).json({ error: "Missing system name" });

        // Ensure we send it as an authorized user (fallback to umesh@piltismart.com)
        const email = (req.user && req.user !== "System/Automation") ? req.user : "umesh@piltismart.com"; 

        // Look up the system ID first
        const apiRes = await axios.get(`http://localhost:8090/api/collections/systems/records?filter=(name='${sysName}')`, {
            headers: { 'X-Webauth-User': email },
            timeout: 2000
        });

        if (!apiRes.data || !apiRes.data.items || apiRes.data.items.length === 0) {
            return res.status(404).json({ error: "System not found in Beszel" });
        }
        
        const sysId = apiRes.data.items[0].id;

        await axios.delete(`http://localhost:8090/api/collections/systems/records/${sysId}`, {
            headers: { 'X-Webauth-User': email }
        });

        logAudit(req.user, 'DELETE_BESZEL', `Deleted Beszel system: ${sysName} (${sysId})`);
        res.json({ message: "System deleted successfully" });
    } catch (e) {
        console.error("[Gateway] Beszel direct delete error:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Failed to delete system from Beszel." });
    }
});

/**
 * @swagger
 * /api/beszel/script:
 *   get:
 *     summary: Generate Beszel Agent deployment script
 *     tags: [Monitoring]
 *     responses:
 *       200: { description: "Returns a bash script" }
 */
adminApp.get('/api/beszel/script', async (req, res) => {
    try {
        let pubKey = "";
        const pubKeyPath = '/beszel_data/id_ed25519.pub';
        const privKeyPath = '/beszel_data/id_ed25519';
        if (!fs.existsSync(pubKeyPath) && fs.existsSync(privKeyPath)) {
            try {
                require('child_process').execSync(`ssh-keygen -y -f ${privKeyPath} > ${pubKeyPath}`);
            } catch(e) {
                console.error("[Gateway] Failed to generate Beszel pub key:", e.message);
            }
        }
        
        if (fs.existsSync(pubKeyPath)) {
            pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
        }

        await getPveTicket();
        const headers = { 'Cookie': pveAuthCookie, 'CSRFPreventionToken': pveCsrfToken };

        const lxcRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/lxc`, { headers });
        const qemuRes = await pveAxios.get(`/api2/json/nodes/${PVE_NODE}/qemu`, { headers });

        let script = "#!/bin/bash\n\n";
        script += "# ==========================================\n";
        script += "# Beszel Agent Deployment Script\n";
        script += "# Run this on your Proxmox Node Shell\n";
        script += "# ==========================================\n\n";
        
        if (pubKey) {
            script += `KEY="${pubKey}"\n\n`;
        } else {
            script += `KEY="YOUR_PUBLIC_KEY_HERE" # Beszel public key not found automatically. Replace this.\n\n`;
        }

        script += "echo \"Deploying Beszel Agent to all running LXC and VM containers...\"\n\n";

        const lxcs = lxcRes.data.data || [];
        for (const lxc of lxcs) {
            if (lxc.status === 'running') {
                script += `# LXC ${lxc.vmid} (${lxc.name})\n`;
                script += `echo "Installing on LXC ${lxc.vmid}..."\n`;
                script += `pct exec ${lxc.vmid} -- bash -c "curl -sL https://raw.githubusercontent.com/henrygd/beszel/main/supplemental/scripts/install-agent.sh | bash -s -- -p 45876 -k \\"$KEY\\""\n\n`;
            }
        }

        const vms = qemuRes.data.data || [];
        for (const vm of vms) {
            if (vm.status === 'running') {
                script += `# VM ${vm.vmid} (${vm.name})\n`;
                script += `echo "Installing on VM ${vm.vmid}..."\n`;
                script += `qm guest exec ${vm.vmid} -- bash -c "curl -sL https://raw.githubusercontent.com/henrygd/beszel/main/supplemental/scripts/install-agent.sh | bash -s -- -p 45876 -k \\"$KEY\\""\n\n`;
            }
        }
        
        script += "echo 'Beszel deployment script completed!'\n";
        res.type('text/plain').send(script);
    } catch (e) {
        console.error("[Gateway] Failed to generate Beszel script:", e.message);
        res.status(500).json({ error: "Failed to generate script." });
    }
});

adminApp.put('/api/routes/:hostname/mode', (req, res) => {
    const hostname = req.params.hostname;
    const { mode } = req.body;
    
    if (!routes[hostname]) {
        return res.status(404).json({ error: "Route not found" });
    }
    
    if (routes[hostname].target.endsWith(':22')) {
        return res.status(400).json({ error: "SSH routes cannot be changed from private mode." });
    }
    
    if (mode !== 'public' && mode !== 'private' && mode !== 'tcp') {
        return res.status(400).json({ error: "Invalid mode." });
    }
    
    routes[hostname].mode = mode;
    saveState();
    res.json({ success: true, mode: mode });
});

/**
 * @swagger
 * /services:
 *   get:
 *     summary: List registered services and their health status
 *     parameters:
 *       - in: query
 *         name: vmid
 *         schema: { type: integer }
 *         description: Filter by Proxmox Container ID
 *       - in: query
 *         name: port
 *         schema: { type: integer }
 *         description: Filter by specific port
 *       - in: query
 *         name: mode
 *         schema: { type: string }
 *         description: Filter by mode (public, private, tcp)
 *     responses:
 *       200:
 *         description: A JSON object grouping services by VMID
 */
let tunnelConnectionsCache = { data: [], lastFetch: 0 };
let beszelStatusCache = {};

function pollBeszelStatus() {
    try {
        const hostIP = new URL(PVE_URL).hostname;
        const remotePollerCmd = `lxc-attach -n 999 -- sqlite3 -json /opt/gateway/beszel_data/data.db 'SELECT id, name, host, status FROM systems;'`;
        const sshCmd = `sshpass -p '${PVE_PASSWORD}' ssh -o StrictHostKeyChecking=no root@${hostIP} "ssh -o StrictHostKeyChecking=no ${PVE_NODE} \\"${remotePollerCmd}\\""`;
        exec(sshCmd, (error, stdout) => {
            if (!error && stdout) {
                try {
                    const data = JSON.parse(stdout);
                    const newCache = {};
                    for (const item of data) {
                        newCache[item.host] = {
                            status: item.status,
                            id: item.id,
                            name: item.name
                        };
                    }
                    beszelStatusCache = newCache;
                } catch(e) {}
            }
        });
    } catch(e) {}
}

setInterval(pollBeszelStatus, 15000);
pollBeszelStatus();

adminApp.get('/services', async (req, res) => {
    const { vmid, port, mode } = req.query;
    const filterVmid = vmid ? parseInt(vmid) : null;
    const filterPort = port ? parseInt(port) : null;

    if (ACTIVE_TUNNEL_ID && (Date.now() - tunnelConnectionsCache.lastFetch > 10000)) {
        try {
            const cfRes = await cfAxios.get(`/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${ACTIVE_TUNNEL_ID}`);
            if (cfRes.data && cfRes.data.result) {
                tunnelConnectionsCache.data = cfRes.data.result.connections || [];
            }
            tunnelConnectionsCache.lastFetch = Date.now();
        } catch (e) {
            console.error("[Gateway] Failed to fetch tunnel connections", e.message);
        }
    }

    const groupedServices = {};
    for (const [hostname, data] of Object.entries(routes)) {
        if (filterVmid && data.vmid !== filterVmid) continue;
        if (filterPort && parseInt(data.target.split(':')[1]) !== filterPort) continue;
        if (mode && data.mode !== mode) continue;

        const vmidStr = data.vmid !== undefined ? data.vmid.toString() : 'unknown';
        if (!groupedServices[vmidStr]) {
            groupedServices[vmidStr] = [];
        }
        groupedServices[vmidStr].push({
            hostname: hostname,
            url: `https://${hostname}`,
            ...data
        });
    }

    res.json({ 
        gateway_status: "active",
        tunnel_id: ACTIVE_TUNNEL_ID,
        tunnel_connections: tunnelConnectionsCache.data,
        last_updated: new Date().toISOString(), 
        services: groupedServices,
        beszel_status: beszelStatusCache
    });
});

/**
 * @swagger
 * /vms:
 *   get:
 *     summary: List all Proxmox VMs and LXCs with routes and Beszel monitoring
 *     description: |
 *       Returns every VM and LXC on the Proxmox node, enriched with:
 *       - Their registered Cloudflare gateway routes
 *       - Live Beszel monitoring status and direct deep-link URL
 *       - Proxmox resource stats (CPU, memory, uptime)
 *
 *       Results are sorted with **running** containers first, then by VMID.
 *     tags: [Infrastructure]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Successfully retrieved VM list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 node:
 *                   type: string
 *                   example: gold
 *                 total:
 *                   type: integer
 *                   description: Total number of VMs/LXCs
 *                   example: 27
 *                 running:
 *                   type: integer
 *                   description: Number currently running
 *                   example: 24
 *                 registered:
 *                   type: integer
 *                   description: Number with at least one gateway route
 *                   example: 4
 *                 monitored:
 *                   type: integer
 *                   description: Number with Beszel agent active (status=up)
 *                   example: 3
 *                 vms:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       vmid:
 *                         type: integer
 *                         example: 101
 *                       name:
 *                         type: string
 *                         example: ollama
 *                       type:
 *                         type: string
 *                         enum: [lxc, qemu]
 *                         example: lxc
 *                       status:
 *                         type: string
 *                         enum: [running, stopped, paused]
 *                         example: running
 *                       node:
 *                         type: string
 *                         example: gold
 *                       cpu:
 *                         type: number
 *                         description: CPU usage fraction (0–1)
 *                         example: 0.02
 *                       mem:
 *                         type: integer
 *                         description: Current memory usage in bytes
 *                         example: 2147483648
 *                       maxmem:
 *                         type: integer
 *                         description: Maximum memory in bytes
 *                         example: 8589934592
 *                       uptime:
 *                         type: integer
 *                         description: Uptime in seconds
 *                         example: 86400
 *                       primary_ip:
 *                         type: string
 *                         nullable: true
 *                         description: IP address derived from registered routes
 *                         example: "192.168.0.28"
 *                       routes_count:
 *                         type: integer
 *                         description: Number of registered gateway routes
 *                         example: 1
 *                       routes:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             hostname:
 *                               type: string
 *                               example: pb11434-gold-101-ollama.piltismart.com
 *                             url:
 *                               type: string
 *                               example: https://pb11434-gold-101-ollama.piltismart.com
 *                             target:
 *                               type: string
 *                               example: "192.168.0.28:11434"
 *                             mode:
 *                               type: string
 *                               enum: [public, private, tcp, secure_tcp]
 *                             status:
 *                               type: string
 *                               enum: [online, offline, unknown]
 *                             latency:
 *                               type: integer
 *                               description: Last measured latency in ms
 *                             createdAt:
 *                               type: string
 *                               format: date-time
 *                       beszel:
 *                         type: object
 *                         nullable: true
 *                         description: Beszel monitoring info (null if agent not installed)
 *                         properties:
 *                           status:
 *                             type: string
 *                             enum: [up, down]
 *                             example: up
 *                           id:
 *                             type: string
 *                             description: PocketBase record ID for direct URL navigation
 *                             example: r57f113f3208f3f
 *                           name:
 *                             type: string
 *                             description: System name as registered in Beszel
 *                             example: ollama
 *                           monitoring_url:
 *                             type: string
 *                             description: Direct deep-link to Beszel system metrics page
 *                             example: https://beszel-gold-gateway.piltismart.com/system/r57f113f3208f3f
 *       500:
 *         description: Failed to reach Proxmox API
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *                 detail: { type: string }
 */
adminApp.get('/vms', async (req, res) => {
    try {
        await getPveTicket();
        const headers = { 'Cookie': pveAuthCookie, 'CSRFPreventionToken': pveCsrfToken };

        // Fetch all LXCs and VMs from Proxmox
        const [lxcRes, qemuRes] = await Promise.allSettled([
            pveAxios.get(`/api2/json/nodes/${PVE_NODE}/lxc`, { headers }),
            pveAxios.get(`/api2/json/nodes/${PVE_NODE}/qemu`, { headers })
        ]);

        const lxcs = (lxcRes.status === 'fulfilled' ? lxcRes.value.data.data : []).map(v => ({ ...v, type: 'lxc' }));
        const qemus = (qemuRes.status === 'fulfilled' ? qemuRes.value.data.data : []).map(v => ({ ...v, type: 'qemu' }));
        const allVms = [...lxcs, ...qemus];

        // Build a lookup of registered routes per VMID
        const routesByVmid = {};
        for (const [hostname, data] of Object.entries(routes)) {
            const vid = String(data.vmid);
            if (!routesByVmid[vid]) routesByVmid[vid] = [];
            routesByVmid[vid].push({
                hostname,
                url: `https://${hostname}`,
                target: data.target,
                mode: data.mode,
                status: data.status,
                latency: data.latency,
                createdAt: data.createdAt
            });
        }

        // Build a lookup of Beszel status per IP
        const beszelByIp = {};
        for (const [ip, entry] of Object.entries(beszelStatusCache)) {
            beszelByIp[ip] = typeof entry === 'object' ? entry : { status: entry };
        }

        // Enrich each VM entry
        const vms = allVms.map(vm => {
            const vmid = String(vm.vmid);
            const registeredRoutes = routesByVmid[vmid] || [];

            // Try to find the primary IP from registered routes
            const primaryIp = registeredRoutes.length > 0
                ? registeredRoutes[0].target.split(':')[0]
                : null;

            const beszel = primaryIp ? (beszelByIp[primaryIp] || null) : null;

            return {
                vmid: vm.vmid,
                name: vm.name || vm.hostname || `vmid-${vm.vmid}`,
                type: vm.type,
                status: vm.status,
                node: PVE_NODE,
                cpu: vm.cpu,
                mem: vm.mem,
                maxmem: vm.maxmem,
                disk: vm.disk,
                uptime: vm.uptime,
                primary_ip: primaryIp,
                routes: registeredRoutes,
                routes_count: registeredRoutes.length,
                beszel: beszel ? {
                    status: beszel.status,
                    id: beszel.id || null,
                    name: beszel.name || null,
                    monitoring_url: beszel.id
                        ? `https://beszel-${PVE_NODE}-gateway.${BASE_DOMAIN}/system/${beszel.id}`
                        : null
                } : null
            };
        });

        // Sort: running first, then by vmid
        vms.sort((a, b) => {
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (a.status !== 'running' && b.status === 'running') return 1;
            return a.vmid - b.vmid;
        });

        res.json({
            node: PVE_NODE,
            total: vms.length,
            running: vms.filter(v => v.status === 'running').length,
            registered: vms.filter(v => v.routes_count > 0).length,
            monitored: vms.filter(v => v.beszel && v.beszel.status === 'up').length,
            vms
        });
    } catch (e) {
        console.error('[Gateway] /vms error:', e.message);
        res.status(500).json({ error: 'Failed to fetch VM list from Proxmox', detail: e.message });
    }
});

// Helper for TCP port scanning
async function scanPorts(ip, ports) {
    const openPorts = [];
    const scanPromises = ports.map(port => {
        return new Promise(resolve => {
            const socket = new require('net').Socket();
            socket.setTimeout(500); // Fast timeout for local network
            socket.on('connect', () => {
                socket.destroy();
                resolve(port);
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
            socket.on('error', () => {
                socket.destroy();
                resolve(null);
            });
            socket.connect(port, ip);
        });
    });

    const results = await Promise.all(scanPromises);
    for (const res of results) {
        if (res !== null) openPorts.push(res);
    }
    return openPorts;
}

/**
 * @swagger
 * /services/auto-discover:
 *   post:
 *     summary: Auto-scan VMs/LXCs and register discovered services
 *     tags: [Infrastructure]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ports:
 *                 type: array
 *                 items: { type: integer }
 *               vmid: { type: integer }
 *     responses:
 *       200:
 *         description: Successfully scanned and registered services
 */
adminApp.post('/services/auto-discover', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendMsg = (msg) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
    };

    try {
        sendMsg({ log: "Starting cluster-wide port scan..." });
        await getPveTicket();
        const headers = { 'Cookie': pveAuthCookie, 'CSRFPreventionToken': pveCsrfToken };

        const [lxcRes, qemuRes] = await Promise.allSettled([
            pveAxios.get(`/api2/json/nodes/${PVE_NODE}/lxc`, { headers }),
            pveAxios.get(`/api2/json/nodes/${PVE_NODE}/qemu`, { headers })
        ]);

        const lxcs = (lxcRes.status === 'fulfilled' ? lxcRes.value.data.data : []).map(v => ({ ...v, type: 'lxc' }));
        const qemus = (qemuRes.status === 'fulfilled' ? qemuRes.value.data.data : []).map(v => ({ ...v, type: 'qemu' }));
        let allVms = [...lxcs, ...qemus].filter(vm => vm.status === 'running');

        if (req.body && req.body.vmid) {
            allVms = allVms.filter(vm => parseInt(vm.vmid) === parseInt(req.body.vmid));
        }

        sendMsg({ log: `Found ${allVms.length} running VMs/LXCs to scan. Beginning deep scan...` });

        let portsToScan = [80, 81, 443, 1880, 5000, 8000, 8080, 8090, 9090, 8123, 11434, 22, 3306, 5432];
        if (req.body && Array.isArray(req.body.ports) && req.body.ports.length > 0) {
            portsToScan = req.body.ports.filter(p => Number.isInteger(p) && p > 0 && p <= 65535);
        }
        
        const registered = [];
        const totalVms = allVms.length;
        let currentVmIdx = 0;
        let isCancelled = false;

        req.on('close', () => {
            console.log('[Gateway] Auto-discover stream aborted by client.');
            isCancelled = true;
        });

        // Scan concurrently but gracefully
        for (const vm of allVms) {
            if (isCancelled) {
                sendMsg({ log: "Operation cancelled by user." });
                break;
            }
            
            currentVmIdx++;
            try {
                let ip, hostname;
                if (vm.type === 'qemu') {
                    const details = await discoverVmDetails(vm.vmid);
                    ip = details.ip; hostname = details.hostname;
                } else {
                    const details = await discoverLxcDetails(vm.vmid);
                    ip = details.ip; hostname = details.hostname;
                }

                if (!ip) {
                    sendMsg({ progress: { current: currentVmIdx, total: totalVms } });
                    continue;
                }
                
                sendMsg({ log: `Scanning VMID ${vm.vmid} (${hostname}) at ${ip}...` });
                sendMsg({ progress: { current: currentVmIdx, total: totalVms } });

                const openPorts = await scanPorts(ip, portsToScan);
                if (openPorts.length === 0) continue;

                sendMsg({ log: `→ VMID ${vm.vmid} (${hostname}) open ports: ${openPorts.join(', ')}` });

                for (const port of openPorts) {
                    // Check if already registered
                    let exists = false;
                    for (const route of Object.values(routes)) {
                        if (route.vmid === vm.vmid && route.target === `${ip}:${port}`) {
                            exists = true;
                            break;
                        }
                    }

                    if (!exists) {
                        let mode = 'public';
                        let protocol = 'http';
                        let idleTimeout = 0;

                        if (port === 443 || port === 8006) protocol = 'https';
                        if (port === 22) { mode = 'tcp'; idleTimeout = 30; }
                        if ([3306, 5432].includes(port)) mode = 'secure_tcp';

                        const expose = [{ port, mode, protocol, idleTimeout }];
                        try {
                            const urls = await registerService(vm.vmid, hostname, ip, expose, false, vm.type);
                            registered.push(...urls);
                        } catch (err) {
                            sendMsg({ log: `  ⚠ Failed to register port ${port}: ${err.message}` });
                        }
                    }
                }
            } catch (err) {
                // Ignore VMs that don't have networking fully up yet
                sendMsg({ log: `  ⚠ Error scanning VMID ${vm.vmid}: ${err.message}` });
                sendMsg({ progress: { current: currentVmIdx, total: totalVms } });
                continue;
            }
        }

        sendMsg({ done: true, message: "Scan complete", newlyRegistered: registered });
    } catch (e) {
        console.error('[Auto-Discover] error:', e.message);
        sendMsg({ error: 'Auto-discovery failed: ' + e.message });
    } finally {
        res.end();
    }
});



/**
 * @swagger
 * /services:
 *   delete:
 *     summary: Unregister/delete existing URLs for a container
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               vmid: { type: integer, description: "Proxmox Container ID" }
 *               port: { type: integer, description: "Optional. Specific port to delete." }
 *               mode: { type: string, description: "Optional. Specific mode to delete ('public', 'private', or 'tcp')." }
 *           examples:
 *             SpecificMode:
 *               summary: Delete a specific URL
 *               value:
 *                 vmid: 101
 *                 port: 11434
 *                 mode: "public"
 *             SpecificPort:
 *               summary: Delete all URLs for a port
 *               value:
 *                 vmid: 101
 *                 port: 11434
 *             EntireContainer:
 *               summary: Delete an entire container
 *               value:
 *                 vmid: 101
 *     responses:
 *       200: { description: "Successfully deleted URLs" }
 *       400: { description: "Invalid payload" }
 *       404: { description: "No matching URLs found" }
 */
adminApp.delete('/services', async (req, res) => {
    const { vmid, port, mode } = req.body;
    
    if (vmid === undefined || typeof vmid !== 'number' || vmid < 0) {
        return res.status(400).json({ error: "Invalid payload: 'vmid' must be a non-negative integer." });
    }

    let deletedCount = 0;
    const hostnamesToDelete = [];
    const adminHostname = `admin-${PVE_NODE || 'proxmox'}-gateway.${BASE_DOMAIN}`;

    for (const [hostname, data] of Object.entries(routes)) {
        if (data.vmid !== vmid) continue;
        
        // Protect the active gateway dashboard from deletion!
        if (hostname === adminHostname) {
            console.log(`[Gateway] Prevented deletion of critical gateway route: ${hostname}`);
            continue;
        }
        
        if (port) {
            const dataPort = parseInt(data.target.split(':')[1]);
            if (dataPort !== port) continue;
        }

        if (mode && data.mode !== mode) {
            continue;
        }

        hostnamesToDelete.push(hostname);
    }

    if (hostnamesToDelete.length === 0) {
        return res.status(404).json({ error: "No matching URLs found to delete." });
    }

    let detailStr = port ? `Port ${port} for VMID ${vmid}` : `ALL routes for VMID ${vmid}`;
    for (const hostname of hostnamesToDelete) {
        await deleteRouteState(hostname);
        deletedCount++;
    }

    saveState();
    logAudit(req.user, port ? 'DELETE_ROUTE' : 'WIPE_CONTAINER', `Deleted ${detailStr} (${deletedCount} routes removed)`);
    await updateTunnelIngress();

    res.json({ message: `Successfully deleted ${deletedCount} URLs.` });
});

/**
 * @swagger
 * /services/all:
 *   delete:
 *     summary: Wipe ALL registered services across all VMs (except the gateway itself)
 *     tags: [Infrastructure]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200: { description: "All services deleted" }
 */
adminApp.delete('/services/all', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendMsg = (msg) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
    };

    try {
        let deletedCount = 0;
        const hostnamesToDelete = [];
        const adminHostname = `admin-${PVE_NODE || 'proxmox'}-gateway.${BASE_DOMAIN}`;
        const beszelHostname = `beszel-${PVE_NODE || 'proxmox'}-gateway.${BASE_DOMAIN}`;

        sendMsg({ log: "Identifying cluster-wide routes for deletion..." });

        for (const [hostname, data] of Object.entries(routes)) {
            // Protect the active gateway dashboard and Beszel hub from deletion!
            if (hostname === adminHostname || hostname === beszelHostname || (data.vmid === 999 && data.target.endsWith(':8080'))) {
                continue;
            }
            hostnamesToDelete.push(hostname);
        }

        if (hostnamesToDelete.length === 0) {
            sendMsg({ error: "No URLs found to delete." });
            return;
        }

        const totalRoutes = hostnamesToDelete.length;
        let currentRouteIdx = 0;
        let isCancelled = false;

        req.on('close', () => {
            console.log('[Gateway] Cluster wipe stream aborted by client.');
            isCancelled = true;
        });

        sendMsg({ log: `Found ${totalRoutes} routes to wipe. Deleting...` });

        for (const hostname of hostnamesToDelete) {
            if (isCancelled) {
                sendMsg({ log: "Wipe operation cancelled by user." });
                break;
            }
            
            currentRouteIdx++;
            sendMsg({ log: `→ Wiping route: ${hostname}` });
            await deleteRouteState(hostname);
            deletedCount++;
            sendMsg({ progress: { current: currentRouteIdx, total: totalRoutes } });
        }

        saveState();
        logAudit(req.user, 'WIPE_CLUSTER', `Wiped all ${deletedCount} route(s) across cluster.`);
        
        sendMsg({ log: "Applying changes to Cloudflare tunnel configuration..." });
        await updateTunnelIngress();

        sendMsg({ done: true, message: `Successfully wiped ${deletedCount} routes from the cluster.` });
    } catch (e) {
        console.error('[Gateway] Failed to execute mass wipe:', e);
        sendMsg({ error: "Wipe operation encountered an error: " + e.message });
    } finally {
        res.end();
    }
});

adminApp.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`[Gateway Admin] Webhook API & Swagger listening on port ${ADMIN_PORT}`);
});


// --- INGRESS PROXY (PORT 8080) ---
const proxyApp = express();

proxyApp.get('/__login__', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

adminApp.get('/', (req, res) => {
    res.redirect('/dashboard');
});

adminApp.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, 'login.html'));
});

adminApp.get('/dashboard', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

proxyApp.post('/__auth__', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${TB_SERVER}/api/auth/login`, { username, password });
        if (response.status === 200) {
            const signature = crypto.createHmac('sha256', GATEWAY_API_KEY).update(username).digest('hex');
            const localToken = `${username}:${signature}`;
            res.json({ token: localToken });
        }
    } catch (error) {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

proxyApp.use(async (req, res, next) => {
    const host = req.hostname || '';
    if (host.startsWith('beszel-') && req.path === '/__sso__') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        let token = req.query.token;
        const cookieHeader = req.headers.cookie;
        let cookieUser;
        
        if (!token && cookieHeader) {
            const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
                const [key, val] = cookie.split('=').map(c => c.trim());
                acc[key] = decodeURIComponent(val);
                return acc;
            }, {});
            token = cookies['gateway_token'];
            cookieUser = cookies['gateway_user'];
        }
        
        console.log(`[SSO DEBUG] host=${host}, token=${token ? 'exists' : 'missing'} (from ${req.query.token ? 'url' : 'cookie'})`);
        
        if (token) {
            let email;
            if (sessions[token]) {
                email = sessions[token].user;
            } else if (token.includes(':')) {
                const [u, sig] = token.split(':');
                const expectedSig = crypto.createHmac('sha256', GATEWAY_API_KEY).update(u).digest('hex');
                if (sig === expectedSig) {
                    email = u;
                    sessions[token] = { user: email, expires: Date.now() + 24 * 60 * 60 * 1000 };
                }
            }
            
            if (email) {
                let redirectUrl = req.query.redirect || '/';
                
                const sysMatch = redirectUrl.match(/^\/system\/(.+)$/);
                if (sysMatch) {
                    const sysName = sysMatch[1];
                    try {
                        const apiRes = await axios.get(`http://localhost:8090/api/collections/systems/records?filter=(name='${sysName}')`, {
                            headers: { 'X-Webauth-User': email },
                            timeout: 2000
                        });
                        if (apiRes.data && apiRes.data.items && apiRes.data.items.length > 0) {
                            redirectUrl = `/system/${apiRes.data.items[0].id}`;
                        }
                    } catch(e) {
                        console.error("[SSO DEBUG] Failed to lookup system ID via API:", e.message);
                    }
                }

                let pbAuth = null;
                try {
                    const authRes = await axios.post(`http://localhost:8090/api/collections/users/auth-refresh`, null, {
                        headers: { 'X-Webauth-User': email },
                        timeout: 2000
                    });
                    if (authRes.data && authRes.data.token) {
                        pbAuth = {
                            token: authRes.data.token,
                            model: authRes.data.record
                        };
                    }
                } catch(e) {
                    console.error("[SSO DEBUG] Failed to refresh genuine auth token:", e.message);
                }

                // Fallback to fake token only if auth-refresh completely fails
                if (!pbAuth) {
                    const fakePayload = Buffer.from(JSON.stringify({
                        id: "pq9jahe66xfrabx", // Hardcoded fallback just in case
                        type: "authRecord",
                        collectionId: "_pb_users_auth_",
                        exp: Math.floor(Date.now() / 1000) + (86400 * 30)
                    })).toString('base64').replace(/=/g, '');
                    const fakeToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${fakePayload}.fakesig`;
                    
                    pbAuth = {
                        token: fakeToken,
                        model: {
                            id: "pq9jahe66xfrabx",
                            email: email,
                            verified: true,
                            role: "admin",
                            collectionId: "_pb_users_auth_",
                            collectionName: "users"
                        }
                    };
                }
                
                const domain = host.split('.').slice(-2).join('.');
                res.cookie('gateway_token', token, { domain: `.${domain}`, path: '/', maxAge: 86400000, secure: true, sameSite: 'lax' });
                res.cookie('gateway_user', email, { domain: `.${domain}`, path: '/', maxAge: 86400000, secure: true, sameSite: 'lax' });
                
                return res.send(`
                    <!DOCTYPE html>
                    <html><head><script>
                        localStorage.setItem('pocketbase_auth', JSON.stringify(${JSON.stringify(pbAuth)}));
                        window.location.href = "${redirectUrl}";
                    </script></head><body>Redirecting to secure dashboard...</body></html>
                `);
            }
        }
        
        return res.status(401).send("Unauthorized. Please log in through the PiltiSmart Gateway first.");
    }

    const route = routes[host];

    if (!route) {
        return res.status(404).send("Service not registered in Gateway");
    }

    route.metrics.requests++;
    const rx = parseInt(req.headers['content-length'] || 0);
    route.metrics.bytesRx += rx;
    
    const initialTx = req.socket ? req.socket.bytesWritten : 0;
    res.on('finish', () => {
        if (req.socket) {
            const finalTx = req.socket.bytesWritten;
            const diff = finalTx - initialTx;
            if (diff > 0) route.metrics.bytesTx += diff;
        }
    });

    if (route.mode === 'private') {
        let token = req.query.token || req.headers['authorization'];
        let cookieToken;
        if (req.headers.cookie) {
             const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
                 const [key, val] = cookie.split('=').map(c => c.trim());
                 acc[key] = decodeURIComponent(val);
                 return acc;
             }, {});
             cookieToken = cookies['gateway_token'];
        }
        token = token || cookieToken;
        let valid = false;
        if (token) {
            if (sessions[token]) {
                valid = true;
            } else if (token.includes(':')) {
                const [u, sig] = token.split(':');
                const expectedSig = crypto.createHmac('sha256', GATEWAY_API_KEY).update(u).digest('hex');
                if (sig === expectedSig) {
                    valid = true;
                    sessions[token] = { user: u, expires: Date.now() + 24 * 60 * 60 * 1000 };
                }
            }
        }
        if (!valid) {
            return res.redirect(`/__login__?redirect=https://${host}${req.originalUrl}`);
        }
    }
    
    if (route) {
        route.activeConnections = (route.activeConnections || 0) + 1;
        res.on('close', () => {
            route.activeConnections = Math.max(0, (route.activeConnections || 1) - 1);
        });
    }

    next();
});

const dynamicProxy = createProxyMiddleware({
    target: 'http://localhost',
    router: function(req) {
        const host = req.hostname || req.headers.host;
        const route = routes[host];
        if (!route) return 'http://localhost';
        if (ttydInstances[host]) {
            return `http://localhost:${ttydInstances[host].port}`;
        }
        const protocol = route.protocol || 'http';
        return `${protocol}://${route.target}`;
    },
    changeOrigin: true,
    ws: true,
    secure: false, // Bypass self-signed SSL cert errors for Proxmox/HTTPS backends
    proxyTimeout: 10 * 60 * 1000, // 10 minutes — needed for Ollama/LLM streaming
    timeout: 10 * 60 * 1000,
    logLevel: 'silent',
    on: {
        proxyReq: function(proxyReq, req, res) {
            const host = req.hostname || req.headers.host || '';
            if (host.startsWith('beszel-')) {
                const cookieHeader = req.headers.cookie;
                let token;
                if (cookieHeader) {
                    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
                        const [key, val] = cookie.split('=').map(c => c.trim());
                        acc[key] = decodeURIComponent(val);
                        return acc;
                    }, {});
                    token = cookies['gateway_token'];
                }
                let email;
                if (token) {
                    if (sessions[token]) {
                        email = sessions[token].user;
                    } else if (token.includes(':')) {
                        const [u, sig] = token.split(':');
                        const expectedSig = crypto.createHmac('sha256', GATEWAY_API_KEY).update(u).digest('hex');
                        if (sig === expectedSig) {
                            email = u;
                            sessions[token] = { user: u, expires: Date.now() + 24 * 60 * 60 * 1000 };
                        }
                    }
                }
                if (email) {
                    console.log(`[PROXY DEBUG] Setting X-Webauth-User to: ${email} for path: ${req.url}`);
                    proxyReq.setHeader('X-Webauth-User', email);
                }
            }
        },
        proxyReqWs: function(proxyReq, req, socket, options, head) {
            const host = req.headers.host || '';
            if (host.startsWith('beszel-')) {
                const cookieHeader = req.headers.cookie;
                let token;
                if (cookieHeader) {
                    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
                        const [key, val] = cookie.split('=').map(c => c.trim());
                        acc[key] = decodeURIComponent(val);
                        return acc;
                    }, {});
                    token = cookies['gateway_token'];
                }
                let email;
                if (token) {
                    if (sessions[token]) {
                        email = sessions[token].user;
                    } else if (token.includes(':')) {
                        const [u, sig] = token.split(':');
                        const expectedSig = crypto.createHmac('sha256', GATEWAY_API_KEY).update(u).digest('hex');
                        if (sig === expectedSig) {
                            email = u;
                            sessions[token] = { user: u, expires: Date.now() + 24 * 60 * 60 * 1000 };
                        }
                    }
                }
                if (email) {
                    proxyReq.setHeader('X-Webauth-User', email);
                }
            }
        },
        error: function(err, req, res) {
            const host = req.hostname || req.headers.host || 'unknown';
            const route = routes[host];
            const target = route ? route.target : 'unknown';
            console.error(`[Proxy Error] ${req.method} ${host}${req.url} -> ${target} | ${err.code || err.message}`);

            // Mark route as potentially offline for self-healing
            if (route) {
                route.status = 'offline';
                route.lastError = err.message;
            }

            // res might be a socket if this is a WebSocket upgrade error
            if (!res || !res.status) {
                if (res && typeof res.destroy === 'function') {
                    res.destroy();
                }
                return;
            }

            if (res.headersSent) return;

            const accept = req.headers['accept'] || '';
            if (accept.includes('application/json')) {
                res.status(502).json({ error: 'Bad Gateway', message: `Could not connect to backend: ${target}`, code: err.code });
            } else {
                res.status(502).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Service Unavailable</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:40px;max-width:500px;text-align:center}
h1{color:#f87171;margin:0 0 12px}p{color:#94a3b8;margin:8px 0}.tag{display:inline-block;background:#0f172a;border:1px solid #475569;border-radius:6px;padding:4px 10px;font-family:monospace;font-size:0.85rem;color:#64748b;margin-top:12px}
a{color:#60a5fa;text-decoration:none}.btn{display:inline-block;margin-top:20px;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><div class="card">
<h1>⚠️ Service Unreachable</h1>
<p>The backend service could not be reached.</p>
<div class="tag">${host}</div><br><div class="tag">${target}</div>
<p style="margin-top:16px;font-size:0.85rem;color:#64748b">Error: ${err.code || err.message}</p>
<a href="javascript:history.back()" class="btn">← Go Back</a>
</div></body></html>`);
            }
        }
    }
});

proxyApp.use(dynamicProxy);

const proxyServer = proxyApp.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Gateway Ingress] Listening for Cloudflare traffic on port ${PROXY_PORT}`);
});

proxyServer.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    const route = routes[host];
    
    if (route && (route.mode === 'public' || req.url.includes('token='))) {
        route.metrics.requests++;
        
        route.activeConnections = (route.activeConnections || 0) + 1;

        socket.on('close', () => {
            route.metrics.bytesRx += socket.bytesRead || 0;
            route.metrics.bytesTx += socket.bytesWritten || 0;
            
            route.activeConnections = Math.max(0, (route.activeConnections || 1) - 1);
            if (route.idleTimeout && route.activeConnections === 0) {
                route.lastActive = Date.now();
            }
        });

        dynamicProxy.upgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});

// --- INIT ---
(async () => {
    console.log("=========================================================");
    console.log(" PiltiSmart Cloudflare Gateway - Proxmox Ingress Controller");
    console.log("=========================================================");

    await setupAutonomousTunnel();
    
    const adminHostname = `admin-${PVE_NODE || 'proxmox'}-gateway.${BASE_DOMAIN}`;
    if (!routes[adminHostname]) {
        console.log(`[Gateway] Auto-registering Admin API at ${adminHostname}`);
        try {
            await createDnsRecord(adminHostname);
            routes[adminHostname] = {
                target: `localhost:${ADMIN_PORT}`,
                mode: 'public',
                vmid: 999,
                status: 'online',
                lastChecked: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                latency: -1,
                metrics: { requests: 0, bytesRx: 0, bytesTx: 0 },
                activeConnections: 0
            };
            saveState();
            await updateTunnelIngress();
        } catch (e) {
            console.error("[Gateway] Failed to auto-register Admin API:", e.message);
        }
    }

    const beszelHostname = `beszel-${PVE_NODE || 'proxmox'}-gateway.${BASE_DOMAIN}`;
    if (!routes[beszelHostname]) {
        console.log(`[Gateway] Auto-registering Beszel Hub at ${beszelHostname}`);
        try {
            await createDnsRecord(beszelHostname);
            routes[beszelHostname] = {
                target: `localhost:8090`,
                mode: 'public',
                vmid: 999,
                status: 'online',
                lastChecked: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                latency: -1,
                metrics: { requests: 0, bytesRx: 0, bytesTx: 0 },
                activeConnections: 0
            };
            saveState();
            await updateTunnelIngress();
        } catch (e) {
            console.error("[Gateway] Failed to auto-register Beszel Hub:", e.message);
        }
    }

    console.log("[Gateway] Syncing Ingress routes with Cloudflare...");
    await updateTunnelIngress();

    console.log("Starting Autonomous Gateway Manager...");
    startCloudflared();
})();
