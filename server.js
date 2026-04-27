const express = require('express');
const axios = require('axios');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Configuration from Environment Variables
const TB_SERVER = process.env.TB_SERVER || 'https://tb.piltismart.com';
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3000;
const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const TARGET_PORT = process.env.TARGET_PORT || 7681;

const TARGET_URL = `http://${TARGET_HOST}:${TARGET_PORT}`;

console.log(`[Gatekeeper] Protecting: ${TARGET_URL}`);
console.log(`[Gatekeeper] Auth Server: ${TB_SERVER}`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Serve Login Page
app.get('/', (req, res, next) => {
    // If there's a token in the query, we skip to the proxy or session check
    if (req.query.token) return next();
    res.sendFile(path.join(__dirname, 'login.html'));
});

// 2. Auth Endpoint (ThingsBoard Login)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${TB_SERVER}/api/auth/login`, {
            username,
            password
        });
        // Return JSON with token (The frontend Fetch call will handle the redirect)
        res.json({ token: response.data.token });
    } catch (error) {
        console.error('[Auth] Login failed');
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// 3. The Guard Middleware
// This checks if the request has a valid token (either in query or headers)
const authGuard = (req, res, next) => {
    const token = req.query.token || req.headers['authorization'];
    if (!token) {
        return res.redirect('/');
    }
    // Note: In a production environment, you should verify the JWT here 
    // by calling ThingsBoard /api/auth/user
    next();
};

// 4. WebSocket Proxy (for ttyd or other WS apps)
const wsProxy = createProxyMiddleware({
    target: TARGET_URL,
    ws: true,
    changeOrigin: true,
    logLevel: 'warn',
});

// 5. Secure Proxy Routes
app.use('/ws', authGuard, wsProxy);
app.use('/token', authGuard, wsPr