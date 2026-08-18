#!/bin/bash
set -e

# Dynamic VMID and IP assignment with fallback
VMID=${1:-${VMID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 101)}}
IP=${2:-${IP:-"10.20.20.20"}}
VNET=${3:-${VNET:-"orangevn"}}
GW=${4:-${GW:-"10.20.20.1"}}

echo "Downloading Ubuntu 22.04 Cloud Image..."
wget -q -nc -O /var/lib/vz/template/iso/jammy-server-cloudimg-amd64.img https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img || true

echo "Enabling snippets on local storage..."
pvesm set local --content vztmpl,iso,backup,snippets || true
mkdir -p /var/lib/vz/snippets

echo "Creating cloud-init user-data..."
cat << 'EOF' > /var/lib/vz/snippets/user-data.yaml
#cloud-config
password: qwer1234
chpasswd: { expire: False }
ssh_pwauth: True
packages:
  - qemu-guest-agent
  - nginx
runcmd:
  - systemctl enable qemu-guest-agent
  - systemctl start qemu-guest-agent
  - systemctl enable nginx
  - systemctl start nginx
EOF

echo "Creating VM $VMID with IP $IP on $VNET..."
# Destroy if already exists
qm stop $VMID || true
qm destroy $VMID || true

qm create $VMID --name test-vm-$VMID --memory 1024 --core 1 --net0 virtio,bridge=$VNET
qm importdisk $VMID /var/lib/vz/template/iso/jammy-server-cloudimg-amd64.img local-lvm
qm set $VMID --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-$VMID-disk-0
qm resize $VMID scsi0 10G
qm set $VMID --ide2 local-lvm:cloudinit
qm set $VMID --boot c --bootdisk scsi0
qm set $VMID --serial0 socket --vga serial0
qm set $VMID --cicustom "user=local:snippets/user-data.yaml"
qm set $VMID --ipconfig0 ip=$IP/24,gw=$GW
qm set $VMID --nameserver 8.8.8.8
qm set $VMID --agent 1

echo "Starting VM $VMID..."
qm start $VMID

echo "Waiting for VM to boot and respond on port 80..."
for i in {1..30}; do
  if curl -m 2 -s http://$IP > /dev/null; then
    echo "VM is up and Nginx is running!"
    break
  fi
  echo "Waiting for Nginx (attempt $i/30)..."
  sleep 5
done

echo "Test VM deployed at $IP"
