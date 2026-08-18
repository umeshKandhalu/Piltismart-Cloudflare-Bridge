# Release Notes - v3.13.0

## Features
- **Deploy Gateway Workspace Skill (`deploy-gateway`)**: Added comprehensive Antigravity workspace skill for deploying, configuring, verifying, and troubleshooting Gateway LXC containers and SDN infrastructure on Proxmox nodes.
- **Dynamic Sample Test Server Deployment**: 
  - Updated test server scripts (`deploy_test_server.sh` and `deploy_test_vm.sh` across `orange` and `purple` nodes) to dynamically query available VMIDs from Proxmox via `pvesh get /cluster/nextid`.
  - Added full support for customizing VMID, IP, VNet, and Gateway via command-line arguments or environment variables.
- **Automated Test Route Registration & Teardown**: Documented end-to-end route registration (`POST /register`), verification, and full cleanup/teardown steps (`POST /unregister`, `pct destroy`, `qm destroy`) to cleanly remove test instances after validation.

---

# Release Notes - v3.12.0

## Features
- **Tailscale Subnet Routing & Custom Hostnames**: Integrated Tailscale subnet routing with custom hostnames in Proxmox node gateways.

---

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
