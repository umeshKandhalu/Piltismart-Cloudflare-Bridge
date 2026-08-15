#!/bin/bash

# Simple wrapper to prompt for SSH username before connecting
echo "ThingsBoard Remote SSH Access"
echo "------------------------------"
read -p "Enter SSH Username: " user

if [ -z "$user" ]; then
    echo "Username cannot be empty. Exiting."
    exit 1
fi

ssh -o StrictHostKeyChecking=no "${user}@${SSH_HOST:-172.17.0.1}"
