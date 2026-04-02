#!/bin/bash
# ============================================================
# AlgaeTree AI – Update Kiosk URL
# ============================================================
# Use this to change the URL the kiosk loads.
#
# Usage: sudo bash update-url.sh https://your-new-url.com
# ============================================================

set -e

if [ -z "$1" ]; then
  echo "Usage: sudo bash update-url.sh <URL>"
  echo "Example: sudo bash update-url.sh https://algaetree.vercel.app"
  exit 1
fi

NEW_URL="$1"
SERVICE_FILE="/etc/systemd/system/algaetree-kiosk.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: Kiosk service not found. Run setup-raspberry-pi.sh first."
  exit 1
fi

# Check if ALGAETREE_URL already exists in the service file
if grep -q "ALGAETREE_URL" "$SERVICE_FILE"; then
  sed -i "s|Environment=ALGAETREE_URL=.*|Environment=ALGAETREE_URL=$NEW_URL|" "$SERVICE_FILE"
else
  sed -i "/Environment=NODE_ENV=production/a Environment=ALGAETREE_URL=$NEW_URL" "$SERVICE_FILE"
fi

systemctl daemon-reload
systemctl restart algaetree-kiosk.service

echo "Kiosk URL updated to: $NEW_URL"
echo "Service restarted."
