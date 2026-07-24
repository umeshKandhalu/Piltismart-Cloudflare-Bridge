# Proxmox VE (PVE) to Google Drive Integration

This document outlines the architecture and setup for integrating Google Drive directly into standard Proxmox Virtual Environment (PVE) nodes (e.g., Gold, Pink, Silver, White, Pluto, Purple). 

> [!NOTE]
> This approach is specifically for **Proxmox VE (PVE)**. It is entirely different from the approach used for Proxmox Backup Server (PBS), which requires a background sync script due to its SQLite chunking architecture.

## Architecture

Unlike PBS, standard Proxmox VE performs backups using `vzdump`, which creates large, sequential archive files (e.g., `.vma.zst`). Because these are large, single files, cloud latency is not an issue. Therefore, the standard and most efficient architecture for PVE is a **Direct FUSE Mount**:

1. **Rclone Mount:** We use `rclone mount` running as a background `systemd` service to mount Google Drive as a local filesystem (e.g., `/mnt/gdrive`).
2. **Proxmox Directory Storage:** We add this local mount point as a standard "Directory" Storage in the Proxmox Web UI. Proxmox treats it like a local disk, allowing you to back up VMs, store ISOs, and save container templates directly to the cloud.

## Google Drive Authentication
Rclone is configured via the standard OAuth browser flow. Once authenticated, the configuration is stored at `/root/.config/rclone/rclone.conf`.

## Systemd Mount Automation

To ensure Google Drive is mounted automatically when the Proxmox node boots, and to prevent backups from failing or writing to the local root disk if the network drops, a dedicated systemd service is used.

### Service File (`/etc/systemd/system/rclone-gdrive.service`)

This service uses VFS (Virtual File System) caching to allow Proxmox to write to Google Drive safely without timeouts.

```ini
[Unit]
Description=Rclone Google Drive Mount
AssertPathIsDirectory=/mnt/gdrive
After=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/rclone mount gdrive: /mnt/gdrive \
  --config /root/.config/rclone/rclone.conf \
  --allow-other \
  --vfs-cache-mode writes \
  --vfs-cache-max-size 10G \
  --dir-cache-time 1m \
  --log-level INFO \
  --log-file /var/log/rclone-mount.log
ExecStop=/bin/fusermount -uz /mnt/gdrive
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

### Enabling the Mount

1. Create the mount directory: `mkdir -p /mnt/gdrive`
2. Enable the service: `systemctl enable rclone-gdrive.service`
3. Start the mount: `systemctl start rclone-gdrive.service`

## Adding to Proxmox Storage

Once the mount is active, it is added to the Proxmox Datacenter. 

**Via Web UI:**
1. Datacenter -> Storage -> Add -> Directory
2. **ID:** `Google-Drive`
3. **Directory:** `/mnt/gdrive`
4. **Content:** VZDump backup file, ISO image, Container template
5. **Nodes:** Select the specific node.

**Via CLI (`pvesm`):**
```bash
pvesm add dir Google-Drive --path /mnt/gdrive --content backup,iso,vztmpl --is_mountpoint 1
```
> [!IMPORTANT]
> The `--is_mountpoint 1` flag is critical. If the Google Drive API goes offline or the rclone mount crashes, this flag prevents Proxmox from accidentally writing backups to the local `/mnt/gdrive` folder and filling up your root hard drive!
