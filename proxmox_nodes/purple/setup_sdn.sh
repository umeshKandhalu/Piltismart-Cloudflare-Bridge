#!/bin/bash
set -e

# Setup SDN for purplelan on Proxmox
# Connect to Proxmox locally since this script runs ON the Proxmox host.

echo "Creating SDN Zone 'purplezn'..."
pvesh create /cluster/sdn/zones --zone purplezn --type simple || true

echo "Creating SDN VNet 'purplevn'..."
pvesh create /cluster/sdn/vnets --vnet purplevn --zone purplezn || true

echo "Creating Subnet '10.70.70.0/24' on VNet 'purplevn'..."
pvesh create /cluster/sdn/vnets/purplevn/subnets --subnet 10.70.70.0/24 --type subnet --gateway 10.70.70.1 --snat 1 || true

echo "Applying SDN Configuration..."
pvesh set /cluster/sdn

echo "SDN Setup Completed."
