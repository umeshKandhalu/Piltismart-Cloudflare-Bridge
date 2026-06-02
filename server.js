const express = require('express');
const axios = require('axios');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

// In-Memory State
let routes = {}; // hostname -> { target, mode, vmid, status, lastChecked }
if (fs.existsSync(STATE_FILE)) {
    try {
        const rawRoutes = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const [key, val] of Object.entries(rawRoutes)) {
            const lKey = key.toLowerCase();
            routes[lKey] = val;
            if (!routes[lKey].metrics) routes[lKey].metrics = { requests: 0, bytesRx: 0, bytesTx: 0 };
            if (routes[lKey].latency === undefined) routes[lKey].latency = -1;
        }
        console.log(`[Gateway] Loaded ${Object.keys(routes).length} existing routes from persistent state.`);
    } catch (e) {
        console.error("[Gateway] Failed to parse existing state file. Starting fresh.");
    }
}
function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(routes, null, 2));
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
            if (data.mode === 'tcp') {
                ingress.push({ hostname: hostname, service: `tcp://${data.target}` });
            } else {
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

async function registerService(vmid, hostname, ip, exposeArray) {
    // Clear old routes for this VMID from state to prevent ghost duplicates
    for (const [existingHostname, data] of Object.entries(routes)) {
        if (data.vmid === vmid) {
            delete routes[existingHostname];
        }
    }

    const generatedUrls = [];
    for (const item of exposeArray) {
        const fullHostname = `${PVE_NODE}-${vmid}-${hostname}.${BASE_DOMAIN}`.toLowerCase();
        let prefix = 'p';
        if (item.mode === 'public') prefix = 'pb';
        else if (item.mode === 'private') prefix = 'pt';
        else if (item.mode === 'tcp') prefix = 'tcp';
        
        const uniqueHostname = `${prefix}${item.port}-${fullHostname}`;
        
        routes[uniqueHostname] = {
            target: `${ip}:${item.port}`,
            mode: item.mode,
            vmid: vmid,
            status: 'pending',
            lastChecked: new Date().toISOString(),
            latency: -1,
            metrics: { requests: 0, bytesRx: 0, bytesTx: 0 }
        };

        await createDnsRecord(uniqueHostname);
        generatedUrls.push({ port: item.port, url: `https://${uniqueHostname}`, mode: item.mode });
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

setInterval(async () => {
    let stateChanged = false;
    for (const [hostname, data] of Object.entries(routes)) {
        const [host, port] = data.target.split(':');
        if (host && port) {
            const startPing = Date.now();
            const currentStatus = await pingTcp(host, parseInt(port));
            const latencyMs = currentStatus === 'online' ? Date.now() - startPing : -1;
            
            // Self-Healing IP Tracking
            if (currentStatus === 'offline' && data.vmid && data.vmid !== 999) {
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
    }
    
    if (stateChanged) {
        saveState();
        await updateTunnelIngress();
    }
}, 15000);

// --- ADMIN API & SWAGGER (PORT 5000) ---
const adminApp = express();
adminApp.use(express.json());

adminApp.use((req, res, next) => {
    // Exclude Swagger UI, Dashboard UI, and related assets from authentication
    if (req.path.startsWith('/docs') || req.path.startsWith('/dashboard') || req.path === '/favicon.ico') {
        return next();
    }
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: Invalid or missing x-api-key" });
    }
    next();
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
adminApp.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerJsdoc(swaggerOptions)));

// --- PROXMOX API CLIENT ---
const pveAxios = axios.create({
    baseURL: PVE_URL,
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
    let { vmid, hostname, ip, expose, override } = req.body;
    
    // Strict Payload Validation
    if (!vmid || typeof vmid !== 'number' || vmid <= 0) {
        return res.status(400).json({ error: "Invalid payload: 'vmid' must be a positive integer." });
    }
    
    let existingVmid = false;
    for (const data of Object.values(routes)) {
        if (data.vmid === vmid) {
            existingVmid = true;
            break;
        }
    }

    if (existingVmid && !override) {
        return res.status(409).json({ error: `VMID ${vmid} already has registered URLs. Pass "override": true in the payload to recreate them.` });
    }

    if (!expose || !Array.isArray(expose) || expose.length === 0) {
        return res.status(400).json({ error: "Invalid payload: 'expose' must be a non-empty array." });
    }

    const seenPorts = new Set();
    for (const item of expose) {
        if (!item.port || typeof item.port !== 'number' || item.port <= 0 || item.port > 65535) {
            return res.status(400).json({ error: `Invalid port: ${item.port}` });
        }
        if (!['public', 'private', 'tcp'].includes(item.mode)) {
            return res.status(400).json({ error: `Invalid mode: ${item.mode} for port ${item.port}. Must be 'public', 'private', or 'tcp'.` });
        }
        if (seenPorts.has(item.port)) {
            return res.status(400).json({ error: `Duplicate port detected in payload: ${item.port}. A port can only be exposed once per container.` });
        }
        seenPorts.add(item.port);
    }

    if (!hostname || !ip) {
        try {
            console.log(`[Gateway] Auto-discovering details for VMID ${vmid}...`);
            const details = await discoverLxcDetails(vmid);
            hostname = hostname || details.hostname;
            ip = ip || details.ip;
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    const urls = await registerService(vmid, hostname, ip, expose);
    res.json({ message: "Registered successfully", urls });
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
adminApp.get('/services', (req, res) => {
    const { vmid, port, mode } = req.query;
    const filterVmid = vmid ? parseInt(vmid) : null;
    const filterPort = port ? parseInt(port) : null;

    const groupedServices = {};
    for (const [hostname, data] of Object.entries(routes)) {
        if (filterVmid && data.vmid !== filterVmid) continue;
        if (filterPort && parseInt(data.target.split(':')[1]) !== filterPort) continue;
        if (mode && data.mode !== mode) continue;

        const vmidStr = data.vmid ? data.vmid.toString() : 'unknown';
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
        last_updated: new Date().toISOString(), 
        services: groupedServices 
    });
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
    
    if (!vmid || typeof vmid !== 'number' || vmid <= 0) {
        return res.status(400).json({ error: "Invalid payload: 'vmid' must be a positive integer." });
    }

    let deletedCount = 0;
    const hostnamesToDelete = [];

    for (const [hostname, data] of Object.entries(routes)) {
        if (data.vmid !== vmid) continue;
        
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

    for (const hostname of hostnamesToDelete) {
        delete routes[hostname];
        deletedCount++;
    }

    saveState();
    await updateTunnelIngress();

    res.json({ message: `Successfully deleted ${deletedCount} URLs.` });
});

adminApp.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`[Gateway Admin] Webhook API & Swagger listening on port ${ADMIN_PORT}`);
});


// --- INGRESS PROXY (PORT 8080) ---
const proxyApp = express();

proxyApp.get('/__login__', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

adminApp.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

proxyApp.post('/__auth__', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${TB_SERVER}/api/auth/login`, { username, password });
        res.json({ token: response.data.token });
    } catch (error) {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

proxyApp.use((req, res, next) => {
    const host = req.hostname;
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
        const token = req.query.token || req.headers['authorization'];
        if (!token) {
            return res.redirect(`/__login__?redirect=https://${host}${req.originalUrl}`);
        }
    }

    const proxy = createProxyMiddleware({
        target: `http://${route.target}`,
        changeOrigin: true,
        ws: true,
        logLevel: 'silent'
    });
    
    proxy(req, res, next);
});

const proxyServer = proxyApp.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Gateway Ingress] Listening for Cloudflare traffic on port ${PROXY_PORT}`);
});

proxyServer.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    const route = routes[host];
    
    if (route && (route.mode === 'public' || req.url.includes('token='))) {
        route.metrics.requests++;
        socket.on('close', () => {
            route.metrics.bytesRx += socket.bytesRead || 0;
            route.metrics.bytesTx += socket.bytesWritten || 0;
        });

        const proxy = createProxyMiddleware({
            target: `http://${route.target}`,
            changeOrigin: true,
            ws: true,
            logLevel: 'silent'
        });
        proxy.upgrade(req, socket, head);
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
                lastChecked: new Date().toISOString()
            };
            saveState();
            await updateTunnelIngress();
        } catch (e) {
            console.error("[Gateway] Failed to auto-register Admin API:", e.message);
        }
    }

    console.log("[Gateway] Syncing Ingress routes with Cloudflare...");
    await updateTunnelIngress();

    console.log("Starting Autonomous Gateway Manager...");
    startCloudflared();
})();
