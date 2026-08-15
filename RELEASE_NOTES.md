# Release Notes - v3.10.0

## Features
- **Proxmox Node Configuration Structure**: Introduced a `proxmox_nodes/` directory structure to logically separate and maintain configurations and deployment scripts for different Proxmox nodes within the cluster.
- **Orange Node Integration**: 
  - Added new deployment configurations and environment structure for the new `orange` node.
  - Added automated scripts to initialize Proxmox Software Defined Networks (SDN) (`setup_sdn.sh`).
  - Added streamlined deployment script for the Gateway LXC using local image building (`deploy_gateway.sh`).
  - Adapted `docker-compose.yml` to run the Gateway standalone, removing the Beszel dependency for this node.
- **Improved LXC Deployment**: The `deploy_gateway.sh` script now implements a robust wait-loop for `dpkg` locks to prevent failures during unattended upgrades when a container first boots.

## Fixes
- Addressed Docker bridge routing issues on Proxmox SNAT networks by injecting `iptables` FORWARD rules directly into the host deployment script.
- Fixed an issue where the Cloudflare tunnel failed to start because it couldn't resolve DNS by explicitly enforcing `8.8.8.8` inside new LXC containers.

## Notes
- Ensure each new node receives its own dedicated `.env` file containing its specific `TUNNEL_TOKEN` inside its respective `proxmox_nodes/<node_name>` directory. These files remain untracked for security.
