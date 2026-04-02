#!/bin/bash
# ============================================================
# AlgaeTree Kiosk – Pre-remove script (runs before uninstall)
# ============================================================
set -e

echo "Stopping AlgaeTree Kiosk..."

# Stop and disable the service
systemctl stop algaetree-kiosk.service 2>/dev/null || true
systemctl disable algaetree-kiosk.service 2>/dev/null || true
