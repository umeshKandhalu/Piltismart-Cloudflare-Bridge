const fs = require('fs');

async function deploy() {
  const tbUrl = 'https://tb.piltismart.com';
  const username = 'sudharsan@piltigroup.com';
  const password = '123456';

  console.log('Logging into ThingsBoard...');
  const loginRes = await fetch(`${tbUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!loginRes.ok) {
    const err = await loginRes.text();
    console.error('Login failed:', err);
    return;
  }

  const { token } = await loginRes.json();
  console.log('Login successful. Uploading Rule Chain...');

  const ruleChainData = JSON.parse(fs.readFileSync('device_created_rule_chain.json', 'utf8'));

  // Create the rule chain
  const rcRes = await fetch(`${tbUrl}/api/ruleChain`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(ruleChainData.ruleChain)
  });

  if (!rcRes.ok) {
    const err = await rcRes.text();
    console.error('Failed to create Rule Chain:', err);
    return;
  }

  const savedRc = await rcRes.json();
  const ruleChainId = savedRc.id;
  console.log('Rule chain created with ID:', ruleChainId.id);

  // Update rule chain metadata
  ruleChainData.metadata.ruleChainId = ruleChainId;
  const metaRes = await fetch(`${tbUrl}/api/ruleChain/metadata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(ruleChainData.metadata)
  });

  if (!metaRes.ok) {
    const err = await metaRes.text();
    console.error('Failed to save metadata:', err);
    return;
  }

  console.log('Rule Chain metadata saved successfully!');
}

deploy().catch(console.error);
