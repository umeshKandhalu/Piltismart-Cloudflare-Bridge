#!/bin/bash
set -e

# Setup SDN for orangelan on Proxmox
# Connect to Proxmox locally since this script runs ON the Proxmox host.

echo "Creating SDN Zone 'orngzone'..."
pvesh create /cluster/sdn/zones --zone orngzone --type simple || true

echo "Creating SDN VNet 'orangevn'..."
pvesh create /cluster/sdn/vnets --vnet orangevn --zone orngzone || true

echo "Creating Subnet '10.20.20.0/24' on VNet 'orangevn'..."
pvesh create /cluster/sdn/vnets/orangevn/subnets --subnet 10.20.20.0/24 --type subnet --gateway 10.20.20.1 --snat 1 || true

echo "Applying SDN Configuration..."
pvesh set /cluster/sdn

echo "SDN Setup Completed."
