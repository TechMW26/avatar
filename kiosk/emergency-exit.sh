#!/bin/bash
# ============================================================
# AlgaeTree AI – Emergency Exit Script
# ============================================================
# This script allows authorized maintenance access.
# SSH into the Pi and run this to temporarily stop the kiosk.
#
# Usage: ssh pi@<ip-address>
#        sudo bash /path/to/kiosk/emergency-exit.sh
# ============================================================

set -e

echo "AlgaeTree Kiosk – Emergency Maintenance"
echo "========================================"
echo ""

# Stop the kiosk service
sudo systemctl stop algaetree-kiosk.service

echo "Kiosk stopped. You now have desktop access."
echo ""
echo "To restart the kiosk:"
echo "  sudo systemctl start algaetree-kiosk"
echo ""
echo "To permanently disable the kiosk:"
echo "  sudo systemctl disable algaetree-kiosk"
echo ""
