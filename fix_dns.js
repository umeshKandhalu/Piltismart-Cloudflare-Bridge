const fs = require('fs');
const axios = require('axios');
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, line) => {
    const parts = line.split('=');
    const k = parts.shift();
    if(k) acc[k.trim()] = parts.join('=').trim();
    return acc;
}, {});
const TUNNEL_ID = "679587f0-e109-4dfd-a1de-a949f0004809";
const cnameTarget = TUNNEL_ID + ".cfargotunnel.com";

(async () => {
    try {
        const hostname = "admin-gold-gateway.piltismart.com";
        const headers = {
            "Authorization": `Bearer ${env.CF_API_TOKEN}`,
            "Content-Type": "application/json"
        };
        const listRes = await axios.get(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?name=${hostname}`, {headers});
        const records = listRes.data.result;
        if(records.length > 0) {
            await axios.put(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${records[0].id}`, {
                type: 'CNAME',
                name: hostname,
                content: cnameTarget,
                proxied: true
            }, {headers});
            console.log("DNS Updated to " + cnameTarget);
        } else {
            console.log("Record not found.");
        }
    } catch(e) { console.error(e.response ? e.response.data : e.message); }
})();
