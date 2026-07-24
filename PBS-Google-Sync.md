# Proxmox Backup Server (PBS) to Google Drive Sync

This document outlines the architecture, configuration, and setup of the automated nightly backup from the Proxmox Backup Server (PBS) node to Google Drive.

## Architecture

Proxmox Backup Server chunks deduplicated backup data into millions of small files indexed via SQLite databases. Because of this architecture, mounting cloud storage (like Google Drive) directly as a PBS Datastore via FUSE is extremely dangerous. High latency can cause garbage collection jobs to take weeks and regularly corrupts the SQLite databases.

We chose the **Local Datastore + Rclone Sync (Option B)** architecture:
1. **Local Backups:** PVE nodes send backups directly to physical Datastores on the PBS node (e.g. `/elk`, `/pluto`, `/white`, `/pilti-backups`). This allows PBS to index and deduplicate at maximum SSD/HDD IOps.
2. **Offsite Sync:** A background job running on the PBS node automatically mirrors the raw, deduplicated chunks from the local Datastores up to Google Drive.

## Google Drive Authentication
To avoid requiring a new interactive OAuth flow, the `rclone.conf` token was securely copied from an existing authenticated node (`White`) to the PBS node at `/root/.config/rclone/rclone.conf`.

## Automated Sync Script

A custom script was deployed to the PBS node at `/usr/local/bin/pbs-gdrive-sync.sh`. 
The script dynamically queries the PBS API to find all local datastores. This ensures that **any new datastores added in the PBS UI in the future will automatically be included in the Google Drive backup.** Remote datastores (like S3 buckets) are filtered out to prevent redundant cloud-to-cloud transfers.

```bash
#!/bin/bash

# Proxmox Backup Server -> Google Drive Sync Script
# Runs nightly via systemd timer to upload deduplicated chunks to GDrive.

LOGFILE="/var/log/pbs-gdrive-sync.log"
echo "--- Starting PBS GDrive Sync at $(date) ---" >> "$LOGFILE"

# Get JSON array of all datastores
DATASTORES_JSON=$(proxmox-backup-manager datastore list --output-format json)

# Use jq to iterate over each datastore where the backend is NOT an S3 bucket
echo "$DATASTORES_JSON" | jq -c '.[] | select(.backend == null)' | while read -r ds; do
    NAME=$(echo "$ds" | jq -r '.name')
    PATH_DIR=$(echo "$ds" | jq -r '.path')

    echo "Syncing datastore: $NAME ($PATH_DIR) to Google Drive..." >> "$LOGFILE"
    
    # Rate limited rclone sync
    /usr/bin/rclone sync "$PATH_DIR" "gdrive:proxmox/PBS-Backup/$NAME" \
        --fast-list --transfers 4 --checkers 8 --tpslimit 8 \
        --drive-chunk-size 64M --max-transfer 700G \
        --stats 1m --log-level INFO --log-file="/var/log/rclone-$NAME.log"
        
    if [ $? -eq 0 ]; then
        echo "SUCCESS: $NAME synced." >> "$LOGFILE"
    else
        echo "ERROR: Failed to sync $NAME. Check /var/log/rclone-$NAME.log" >> "$LOGFILE"
    fi
done

echo "--- Finished PBS GDrive Sync at $(date) ---" >> "$LOGFILE"
```

## API Limit Protections

Because PBS creates millions of tiny chunks, uploading them blindly to Google Drive will trigger severe API bans (10 requests per second limit) and data caps (750GB daily limit). The script uses the following protections:

- `--tpslimit 8`: Hard-caps API transactions to 8 per second, staying safely under Google's 10/sec ban threshold.
- `--transfers 4` & `--checkers 8`: Reduces concurrent uploads to prevent API bursts.
- `--drive-chunk-size 64M`: Batches data into larger chunks in memory so fewer API calls are made.
- `--max-transfer 700G`: Safely stops the sync at 700GB. If an initial backup is massive, it stops gracefully before hitting the absolute 750GB daily ban threshold and resumes the next night.

## Systemd Automation

The script is executed automatically every night at 2:00 AM via a systemd timer.

### 1. Service File (`/etc/systemd/system/pbs-gdrive-sync.service`)
```ini
[Unit]
Description=Proxmox Backup Server Google Drive Sync
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pbs-gdrive-sync.sh
User=root
```

### 2. Timer File (`/etc/systemd/system/pbs-gdrive-sync.timer`)
```ini
[Unit]
Description=Run Proxmox Backup Server Google Drive Sync Nightly

[Timer]
OnCalendar=*-*-* 02:00:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
```

To view the timer status:
`systemctl status pbs-gdrive-sync.timer`

To trigger the backup manually during the day:
`systemctl start pbs-gdrive-sync.service`
