# Terraform configuration for Proxmox SDN

terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.60.0"
    }
  }
}

# Configure the Proxmox provider using the Gold Node's API
provider "proxmox" {
  endpoint = "https://192.168.0.100:8006/"
  username = "root@pam"
  password = "qwer1234"
  insecure = true  # Set to false if you have a valid SSL certificate
}

# 1. Create the Restricted Simple Zone
resource "proxmox_virtual_environment_sdn_zone_simple" "goldzone" {
  zone  = "goldzone"
  nodes = ["gold"]
  ipam  = "pve"
  dhcp  = "dnsmasq"
}

# 2. Create the VNet assigned to the Zone
resource "proxmox_virtual_environment_sdn_vnet" "goldvnet" {
  vnet = "goldvnet"
  zone = proxmox_virtual_environment_sdn_zone_simple.goldzone.zone
}

# 3. Create the Subnet with SNAT (and implicitly DHCP via the Zone's dnsmasq)
resource "proxmox_virtual_environment_sdn_subnet" "gold_subnet" {
  vnet = proxmox_virtual_environment_sdn_vnet.goldvnet.id
  cidr = "10.50.50.0/24"
  
  gateway = "10.50.50.1"
  snat    = true
}

# 4. Apply the SDN configuration across the cluster
resource "proxmox_virtual_environment_sdn_applier" "network_applier" {
  depends_on = [
    proxmox_virtual_environment_sdn_vnet.goldvnet,
    proxmox_virtual_environment_sdn_subnet.gold_subnet
  ]
}

# (Optional) Example of attaching a VM to the newly created SDN VNet
# resource "proxmox_virtual_environment_vm" "example_vm" {
#   node_name = "gold"
#   vm_id     = 102
#   name      = "test-sdn-vm"
#
#   network_device {
#     bridge = proxmox_virtual_environment_sdn_vnet.goldvnet.vnet
#     model  = "virtio"
#   }
# }
