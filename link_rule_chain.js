const fs = require('fs');

async function linkRuleChain() {
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
    console.error('Login failed:', await loginRes.text());
    return;
  }
  const { token } = await loginRes.json();
  const authHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Authorization': `Bearer ${token}`
  };

  // 1. Get all rule chains to find the Root Rule Chain and our Kafka Rule Chain
  const rcRes = await fetch(`${tbUrl}/api/ruleChains?pageSize=100&page=0`, { headers: authHeaders });
  const rcData = await rcRes.json();
  
  if (!rcData || !rcData.data) {
    console.error('Invalid rule chains response:', rcData);
    return;
  }

  const rootRc = rcData.data.find(rc => rc.root === true);
  const targetRc = rcData.data.find(rc => rc.name === 'Device Creation External Trigger (Kafka)');

  if (!rootRc) {
    console.error('Root Rule Chain not found!');
    return;
  }
  if (!targetRc) {
    console.error('Kafka Rule Chain not found!');
    return;
  }

  console.log(`Found Root Rule Chain: ${rootRc.name} (${rootRc.id.id})`);
  console.log(`Found Target Rule Chain: ${targetRc.name} (${targetRc.id.id})`);

  // 2. Fetch Root Rule Chain Metadata
  const metaRes = await fetch(`${tbUrl}/api/ruleChain/${rootRc.id.id}/metadata`, { headers: authHeaders });
  const metadata = await metaRes.json();

  // 3. Find Message Type Switch node
  const msgTypeSwitchIdx = metadata.nodes.findIndex(n => n.type === 'org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode');
  if (msgTypeSwitchIdx === -1) {
    console.error('Could not find Message Type Switch node in the Root Rule Chain.');
    return;
  }

  // 4. Find or create the Rule Chain Input Node
  let targetNodeIdx = metadata.nodes.findIndex(n => 
    n.type === 'org.thingsboard.rule.engine.flow.TbRuleChainInputNode' && 
    n.configuration.ruleChainId === targetRc.id.id
  );

  let updated = false;

  if (targetNodeIdx === -1) {
    console.log('Adding Rule Chain Input Node to Root Rule Chain...');
    metadata.nodes.push({
      additionalInfo: {
        description: "Forward to Kafka trigger",
        layoutX: 850,
        layoutY: 250
      },
      type: "org.thingsboard.rule.engine.flow.TbRuleChainInputNode",
      name: "Kafka Device Creation Trigger",
      debugMode: false,
      configuration: {
        ruleChainId: targetRc.id.id
      }
    });
    targetNodeIdx = metadata.nodes.length - 1;
    updated = true;
  }

  // 5. Check if connection exists
  const connectionExists = metadata.connections.some(c => 
    c.fromIndex === msgTypeSwitchIdx && 
    c.toIndex === targetNodeIdx && 
    c.type === 'Entity Created'
  );

  if (!connectionExists) {
    console.log('Adding "Entity Created" connection...');
    metadata.connections.push({
      fromIndex: msgTypeSwitchIdx,
      toIndex: targetNodeIdx,
      type: "Entity Created"
    });
    updated = true;
  }

  // 6. Save Metadata if updated
  if (updated) {
    console.log('Saving updated Root Rule Chain metadata...');
    const saveRes = await fetch(`${tbUrl}/api/ruleChain/metadata`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(metadata)
    });

    if (!saveRes.ok) {
      console.error('Failed to save metadata:', await saveRes.text());
      return;
    }
    console.log('Successfully linked the Rule Chain! Device creation events should now flow to the Kafka Rule Chain.');
  } else {
    console.log('The rule chain is already properly linked in the Root Rule Chain. No changes needed.');
  }
}

linkRuleChain().catch(console.error);
