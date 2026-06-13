#!/bin/bash
# Script to migrate all White VMs and LXCs from vmbr0 to whitevn

echo "=== Starting Migration on $(hostname) ==="

# 1. Migrate LXCs
echo "=== Processing LXCs ==="
for vmid in $(pct list | awk 'NR>1 {print $1}'); do
  # Skip Gateway LXC
  if [ "$vmid" = "999" ]; then
    echo "Skipping Gateway LXC 999"
    continue
  fi
  
  # Get active net0 config
  config=$(pct config "$vmid" 2>/dev/null | grep '^net0:')
  if [ -z "$config" ]; then
    continue
  fi
  
  if echo "$config" | grep -q 'bridge=vmbr0'; then
    echo "Updating LXC $vmid..."
    
    # Extract config value (remove 'net0: ' prefix)
    val=$(echo "$config" | sed 's/^net0:\s*//')
    
    # Process net0 parameters
    new_val=$(echo "$val" | sed 's/bridge=vmbr0/bridge=whitevn/g')
    new_val=$(echo "$new_val" | sed -E 's/ip=[^,]*/ip=dhcp/g')
    new_val=$(echo "$new_val" | sed -E 's/,gw=[^,]*//g' | sed -E 's/gw=[^,]*,//g')
    
    echo "Setting net0 for LXC $vmid to: $new_val"
    pct set "$vmid" -net0 "$new_val"
    
    # Reboot if running
    if pct status "$vmid" | grep -q 'running'; then
      echo "Rebooting LXC $vmid..."
      pct reboot "$vmid"
    fi
  fi
done

# 2. Migrate VMs
echo "=== Processing VMs ==="
for vmid in $(qm list | awk 'NR>1 {print $1}'); do
  # Get active net0 config
  config=$(qm config "$vmid" 2>/dev/null | grep '^net0:')
  if [ -z "$config" ]; then
    continue
  fi
  
  if echo "$config" | grep -q 'bridge=vmbr0'; then
    echo "Updating VM $vmid..."
    
    # Extract config value
    val=$(echo "$config" | sed 's/^net0:\s*//')
    
    # Process net0 parameters (just swap bridge)
    new_val=$(echo "$val" | sed 's/bridge=vmbr0/bridge=whitevn/g')
    
    echo "Setting net0 for VM $vmid to: $new_val"
    qm set "$vmid" -net0 "$new_val"
    
    # Reboot if running
    if qm status "$vmid" | grep -q 'running'; then
      echo "Rebooting VM $vmid..."
      qm reboot "$vmid"
    fi
  fi
done

echo "=== Migration Complete ==="
