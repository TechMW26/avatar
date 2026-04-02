#!/bin/bash
# ============================================================
# AlgaeTree Kiosk – Post-install script (runs after dpkg -i)
# ============================================================
set -e

APP_DIR="/opt/AlgaeTree Kiosk"
APP_USER="${SUDO_USER:-pi}"
APP_HOME=$(eval echo "~$APP_USER")
CONF_SOURCE="$APP_DIR/resources/conf"

echo "╔═══════════════════════════════════════════════╗"
echo "║    AlgaeTree Kiosk – Configuring system...    ║"
echo "╚═══════════════════════════════════════════════╝"

# ── 1. Disable screen blanking ──
if [ -d "$CONF_SOURCE" ]; then
  cp "$CONF_SOURCE/10-disable-blanking.conf" /etc/X11/xorg.conf.d/ 2>/dev/null || true
fi

# ── 2. Disable lightdm screensaver if present ──
if [ -f /etc/lightdm/lightdm.conf ]; then
  if ! grep -q "xserver-command" /etc/lightdm/lightdm.conf; then
    sed -i '/^\[Seat:\*\]/a xserver-command=X -s 0 -dpms' /etc/lightdm/lightdm.conf
  fi
fi

# ── 3. Install systemd service ──
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
WorkingDirectory=$APP_DIR
ExecStartPre=/bin/sleep 5
ExecStart=$APP_DIR/algaetree-kiosk --no-sandbox --disable-gpu-sandbox
Restart=always
RestartSec=3
StartLimitIntervalSec=0

[Install]
WantedBy=graphical.target
SERVICEEOF

systemctl daemon-reload
systemctl enable algaetree-kiosk.service

# ── 4. Configure kiosk lockdown (openbox) ──
OPENBOX_DIR="$APP_HOME/.config/openbox"
mkdir -p "$OPENBOX_DIR"
cat > "$OPENBOX_DIR/rc.xml" << 'OBEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <resistance><strength>10</strength><screen_edge_strength>20</screen_edge_strength></resistance>
  <focus><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <desktops><number>1</number></desktops>
  <keyboard></keyboard>
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

# ── 5. Hide mouse cursor & disable screensaver ──
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

# ── 6. Configure auto-login ──
raspi-config nonint do_boot_behaviour B4 2>/dev/null || {
  if [ -f /etc/lightdm/lightdm.conf ]; then
    sed -i "s/^#autologin-user=.*/autologin-user=$APP_USER/" /etc/lightdm/lightdm.conf
    sed -i "s/^#autologin-user-timeout=.*/autologin-user-timeout=0/" /etc/lightdm/lightdm.conf
  fi
}

# ── 7. Create convenience symlinks ──
ln -sf "$APP_DIR/algaetree-kiosk" /usr/local/bin/algaetree-kiosk

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║          Installation Complete!               ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""
echo "The AlgaeTree AI kiosk will start on next boot."
echo ""
echo "  Start now:  sudo systemctl start algaetree-kiosk"
echo "  Stop:       sudo systemctl stop algaetree-kiosk"
echo "  Status:     sudo systemctl status algaetree-kiosk"
echo "  Logs:       journalctl -u algaetree-kiosk -f"
echo ""
