#!/bin/bash
# ============================================================
# AlgaeTree AI – Raspberry Pi Kiosk Setup Script
# ============================================================
# This script configures a Raspberry Pi to run AlgaeTree AI
# as a fullscreen kiosk application that starts on boot.
#
# Tested on: Raspberry Pi OS (Bookworm) 64-bit with Desktop
# Run as:    sudo bash setup-raspberry-pi.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

KIOSK_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-pi}"
APP_HOME=$(eval echo "~$APP_USER")

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════╗"
echo "║     AlgaeTree AI – Raspberry Pi Kiosk Setup   ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Check root ──
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run with sudo: sudo bash setup-raspberry-pi.sh${NC}"
  exit 1
fi

# ── Step 1: System update & dependencies ──
echo -e "${YELLOW}[1/8] Updating system packages...${NC}"
apt-get update -y
apt-get upgrade -y

echo -e "${YELLOW}[2/8] Installing dependencies...${NC}"
apt-get install -y \
  curl \
  git \
  network-manager \
  xdotool \
  unclutter \
  xserver-xorg \
  x11-xserver-utils \
  libgtk-3-0 \
  libnotify4 \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgcc-s1 \
  libglib2.0-0 \
  libnspr4 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxtst6

# ── Step 3: Install Node.js (LTS) ──
echo -e "${YELLOW}[3/8] Installing Node.js LTS...${NC}"
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js: $(node -v)"
echo "npm: $(npm -v)"

# ── Step 3b: Enable camera and add user to video group ──
echo -e "${YELLOW}[3b/8] Enabling camera...${NC}"
# Enable the camera interface (legacy + libcamera)
raspi-config nonint do_camera 0 2>/dev/null || true
# Ensure the user is in the video group (needed for camera device access)
usermod -aG video "$APP_USER" 2>/dev/null || true
# Load the V4L2 camera module if not already loaded
if ! lsmod | grep -q bcm2835_v4l2; then
  modprobe bcm2835-v4l2 2>/dev/null || true
fi
# Ensure it loads on boot
if ! grep -q "bcm2835-v4l2" /etc/modules 2>/dev/null; then
  echo "bcm2835-v4l2" >> /etc/modules 2>/dev/null || true
fi
echo "Camera enabled"

# ── Step 4: Install kiosk app dependencies ──
echo -e "${YELLOW}[4/8] Installing kiosk application...${NC}"
cd "$KIOSK_DIR"
sudo -u "$APP_USER" npm install --production

# ── Step 5: Disable screen blanking & screensaver ──
echo -e "${YELLOW}[5/8] Disabling screen blanking & screensaver...${NC}"

# Disable DPMS and screensaver via xorg config
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-disable-blanking.conf << 'XORGEOF'
Section "ServerFlags"
    Option "BlankTime" "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime" "0"
EndSection

Section "ServerLayout"
    Identifier "ServerLayout0"
    Option "BlankTime" "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime" "0"
EndSection
XORGEOF

# Disable lightdm screensaver if present
if [ -f /etc/lightdm/lightdm.conf ]; then
  if ! grep -q "xserver-command" /etc/lightdm/lightdm.conf; then
    sed -i '/^\[Seat:\*\]/a xserver-command=X -s 0 -dpms' /etc/lightdm/lightdm.conf
  fi
fi

# ── Step 6: Create systemd service ──
echo -e "${YELLOW}[6/8] Creating systemd service...${NC}"
cat > /etc/systemd/system/algaetree-kiosk.service << SERVICEEOF
[Unit]
Description=AlgaeTree AI Kiosk
After=graphical.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Environment=DISPLAY=:0
Environment=XAUTHORITY=$APP_HOME/.Xauthority
Environment=NODE_ENV=production
Environment=ELECTRON_DISABLE_SANDBOX=1
WorkingDirectory=$KIOSK_DIR
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/npx electron . --no-sandbox --disable-gpu-sandbox --use-fake-ui-for-media-stream
Restart=always
RestartSec=3
StartLimitIntervalSec=0

[Install]
WantedBy=graphical.target
SERVICEEOF

systemctl daemon-reload
systemctl enable algaetree-kiosk.service

# ── Step 7: Disable keyboard shortcuts & lock down desktop ──
echo -e "${YELLOW}[7/8] Configuring kiosk lockdown...${NC}"

# Create openbox config to disable all keyboard shortcuts
OPENBOX_DIR="$APP_HOME/.config/openbox"
mkdir -p "$OPENBOX_DIR"
cat > "$OPENBOX_DIR/rc.xml" << 'OBEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <resistance><strength>10</strength><screen_edge_strength>20</screen_edge_strength></resistance>
  <focus><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <desktops><number>1</number></desktops>
  <keyboard>
    <!-- All keyboard shortcuts disabled for kiosk mode -->
  </keyboard>
  <mouse>
    <context name="Frame">
      <mousebind button="A-Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>
  </mouse>
  <applications>
    <application class="*">
      <decor>no</decor>
      <maximized>yes</maximized>
      <fullscreen>yes</fullscreen>
    </application>
  </applications>
</openbox_config>
OBEOF
chown -R "$APP_USER:$APP_USER" "$OPENBOX_DIR"

# Hide mouse cursor after 0.5 seconds of inactivity
AUTOSTART_DIR="$APP_HOME/.config/lxsession/LXDE-pi"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/autostart" << 'ASEOF'
@lxpanel --profile LXDE-pi
@pcmanfm --desktop --profile LXDE-pi
@xset s off
@xset -dpms
@xset s noblank
@unclutter -idle 0.5 -root
ASEOF
chown -R "$APP_USER:$APP_USER" "$APP_HOME/.config"

# ── Step 8: Configure auto-login ──
echo -e "${YELLOW}[8/8] Configuring auto-login...${NC}"

# Enable auto-login for the desktop session
raspi-config nonint do_boot_behaviour B4 2>/dev/null || {
  # Fallback: configure lightdm directly
  if [ -f /etc/lightdm/lightdm.conf ]; then
    sed -i "s/^#autologin-user=.*/autologin-user=$APP_USER/" /etc/lightdm/lightdm.conf
    sed -i "s/^#autologin-user-timeout=.*/autologin-user-timeout=0/" /etc/lightdm/lightdm.conf
  fi
}

# ── Done ──
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════╗"
echo "║          Setup Complete!                       ║"
echo "╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo "The AlgaeTree AI kiosk will start automatically on next boot."
echo ""
echo "Quick commands:"
echo "  Start now:    sudo systemctl start algaetree-kiosk"
echo "  Stop:         sudo systemctl stop algaetree-kiosk"
echo "  Status:       sudo systemctl status algaetree-kiosk"
echo "  Logs:         journalctl -u algaetree-kiosk -f"
echo ""
echo -e "${YELLOW}Rebooting in 10 seconds... (Ctrl+C to cancel)${NC}"
sleep 10
reboot
