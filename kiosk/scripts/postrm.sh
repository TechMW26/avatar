#!/bin/bash
# ============================================================
# AlgaeTree Kiosk – Post-remove script (runs after uninstall)
# ============================================================
set -e

echo "Cleaning up AlgaeTree Kiosk..."

# Remove systemd service
rm -f /etc/systemd/system/algaetree-kiosk.service
systemctl daemon-reload

# Remove xorg config
rm -f /etc/X11/xorg.conf.d/10-disable-blanking.conf

# Remove convenience symlink
rm -f /usr/local/bin/algaetree-kiosk

echo "AlgaeTree Kiosk has been removed."
