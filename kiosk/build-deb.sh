#!/bin/bash
# ============================================================
# AlgaeTree Kiosk – Build .deb Package
# ============================================================
# Builds an installable .deb package for Raspberry Pi (arm64).
#
# Prerequisites (on your dev machine):
#   - Node.js 18+
#   - npm
#
# Usage:
#   cd kiosk/
#   bash build-deb.sh              # arm64 (Pi 4/5)
#   bash build-deb.sh --armv7l     # armv7l (Pi 3 / older)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════╗"
echo "║    AlgaeTree Kiosk – Building .deb Package    ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Check prerequisites ──
if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js is required. Install it from https://nodejs.org${NC}"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo -e "${RED}npm is required. Install Node.js from https://nodejs.org${NC}"
  exit 1
fi

# ── Install dependencies ──
echo -e "${YELLOW}[1/3] Installing build dependencies...${NC}"
npm install

# ── Make scripts executable ──
echo -e "${YELLOW}[2/3] Preparing package scripts...${NC}"
chmod +x scripts/postinst.sh scripts/prerm.sh scripts/postrm.sh

# ── Build ──
echo -e "${YELLOW}[3/3] Building .deb package...${NC}"
if [ "$1" = "--armv7l" ]; then
  echo "Target architecture: armv7l (Raspberry Pi 3 / older)"
  npm run build:deb:armv7l
else
  echo "Target architecture: arm64 (Raspberry Pi 4/5)"
  npm run build:deb
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════╗"
echo "║            Build Complete!                      ║"
echo "╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo "Your .deb package is in: kiosk/dist/"
echo ""
echo "To install on a Raspberry Pi:"
echo "  1. Copy the .deb file to the Pi:"
echo "     scp dist/algaetree-kiosk_*.deb pi@<pi-ip>:~/"
echo ""
echo "  2. SSH into the Pi and install:"
echo "     sudo dpkg -i algaetree-kiosk_*.deb"
echo "     sudo apt-get install -f   # install any missing dependencies"
echo ""
echo "  3. Reboot:"
echo "     sudo reboot"
echo ""
