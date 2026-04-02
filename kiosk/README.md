# AlgaeTree AI – Raspberry Pi Kiosk Setup

This directory contains everything needed to run AlgaeTree AI as a **locked-down fullscreen kiosk** on a Raspberry Pi. You can install it as a **`.deb` package** — no manual setup required.

---

## Features

- **Installable `.deb` package** — Single-command install via `dpkg -i`, clean uninstall supported
- **Fullscreen kiosk mode** — Electron app runs in true kiosk/fullscreen, no window chrome
- **Auto-start on boot** — Starts automatically via systemd service
- **Cannot be exited** — All keyboard shortcuts (Alt+F4, Ctrl+W, Ctrl+Q, Escape, etc.) are blocked
- **Auto-restart on crash** — systemd restarts the app within 3 seconds if it crashes
- **Offline WiFi setup** — If no internet, shows a guided WiFi connection screen with network scanning
- **Ethernet guide** — Step-by-step Ethernet connection instructions as fallback
- **Auto-reconnect** — Continuously checks for internet and auto-loads the app when connected
- **Screen always on** — Screen blanking, DPMS, and screensaver are all disabled
- **Mouse cursor hidden** — Hides after 0.5 seconds of inactivity (touch-friendly)
- **Microphone access** — Pre-approved for the ElevenLabs voice conversation feature

---

## Requirements

- **Raspberry Pi 4 or 5** (4GB+ RAM recommended)
- **Raspberry Pi OS (Bookworm)** — 64-bit Desktop version
- **Internet connection** for initial setup (WiFi or Ethernet)
- **Display** connected via HDMI
- **Microphone** (USB or 3.5mm) for voice conversation feature

---

## Installation (Recommended)

### 1. Build the `.deb` package

On your development machine (macOS/Linux with Node.js 18+):

```bash
cd kiosk/
bash build-deb.sh              # For Pi 4/5 (arm64)
bash build-deb.sh --armv7l     # For Pi 3 or older (armv7l)
```

This produces a `.deb` file in `kiosk/dist/`.

### 2. Flash Raspberry Pi OS

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to flash **Raspberry Pi OS (64-bit) with Desktop** to your SD card.

In the imager settings, enable:
- **SSH** (for remote maintenance access)
- **WiFi** (enter your network credentials)
- Set **username** to `pi`

### 3. Copy and install the `.deb` package

```bash
# Copy .deb to the Pi
scp kiosk/dist/algaetree-kiosk_*.deb pi@<pi-ip>:~/

# SSH into the Pi
ssh pi@<pi-ip>

# Install the package (auto-installs dependencies)
sudo dpkg -i algaetree-kiosk_*.deb
sudo apt-get install -f

# Reboot to start the kiosk
sudo reboot
```

That's it! After reboot, AlgaeTree AI launches automatically in fullscreen kiosk mode.

### Uninstall

```bash
sudo dpkg -r algaetree-kiosk
```

This cleanly removes the app, systemd service, and all kiosk configurations.

---

## Alternative: Manual Setup

If you prefer not to use the `.deb` package, the manual setup scripts are still available:

```bash
scp -r kiosk/ pi@<pi-ip>:~/algaetree-kiosk/
ssh pi@<pi-ip>
cd ~/algaetree-kiosk
sudo bash setup-raspberry-pi.sh
```

---

## Changing the App URL

By default, the kiosk loads `https://algaetree.vercel.app`. To change this:

```bash
sudo bash ~/algaetree-kiosk/update-url.sh https://your-url.com
```

---

## Maintenance Access

The kiosk is designed so the user cannot exit. For maintenance, **SSH into the Pi**:

```bash
ssh pi@<pi-ip-address>
sudo bash ~/algaetree-kiosk/emergency-exit.sh
```

This stops the kiosk and gives you normal desktop access.

### Useful Commands

| Action | Command |
|--------|---------|
| Start kiosk | `sudo systemctl start algaetree-kiosk` |
| Stop kiosk | `sudo systemctl stop algaetree-kiosk` |
| Restart kiosk | `sudo systemctl restart algaetree-kiosk` |
| Check status | `sudo systemctl status algaetree-kiosk` |
| View logs | `journalctl -u algaetree-kiosk -f` |
| Disable auto-start | `sudo systemctl disable algaetree-kiosk` |
| Re-enable auto-start | `sudo systemctl enable algaetree-kiosk` |

---

## How It Works

```
Boot → Auto-login → Desktop → systemd starts Electron kiosk
                                      │
                        ┌─────────────┤
                        ▼             ▼
                  Internet OK     No Internet
                        │             │
                        ▼             ▼
               Load AlgaeTree    Show WiFi Setup
                web app (URL)    Guide with network
                                 scanning & connect
                        │             │
                        └──────┬──────┘
                               │
                    Continuous connectivity
                    check every 5 seconds
```

### Lockdown Mechanisms

1. **Electron kiosk mode** — `kiosk: true, fullscreen: true, frame: false`
2. **Global shortcut blocking** — Registers and blocks Alt+F4, Ctrl+W, Ctrl+Q, Escape, F keys, Alt+Tab, Super key
3. **Window close prevention** — `close` event is intercepted and prevented
4. **Fullscreen enforcement** — `leave-full-screen` event forces back to fullscreen
5. **DevTools disabled** — Automatically closes if somehow opened
6. **New window prevention** — `setWindowOpenHandler` denies all popups
7. **Openbox lockdown** — Desktop window manager configured with zero keyboard shortcuts
8. **systemd auto-restart** — If the process crashes, systemd restarts it in 3 seconds

---

## Troubleshooting

### Black screen after boot
- Check logs: `journalctl -u algaetree-kiosk -f`
- The service waits 5 seconds after the graphical target is ready
- Ensure HDMI display is connected before boot

### App shows offline screen but WiFi works
- The app checks `https://www.google.com` for connectivity
- If this is blocked on your network, edit the `CONNECTIVITY_CHECK_URL` in `main.js`

### Touch screen not calibrated
- Run `sudo apt install xserver-xorg-input-evdev` and follow calibration guides for your specific touchscreen

### Need to change display resolution
```bash
# Edit boot config
sudo nano /boot/config.txt
# Or for Bookworm:
sudo nano /boot/firmware/config.txt

# Set resolution (example: 1920x1080)
hdmi_group=2
hdmi_mode=82
```

---

## File Structure

```
kiosk/
├── main.js                  # Electron main process (kiosk window, shortcuts, WiFi)
├── preload.js               # Secure bridge for WiFi operations
├── offline.html             # Offline page with WiFi setup guide
├── package.json             # Node/Electron dependencies & build config
├── electron-builder.yml     # electron-builder config for .deb packaging
├── build-deb.sh             # Build the .deb package (run on dev machine)
├── conf/
│   └── 10-disable-blanking.conf  # Xorg config bundled into the .deb
├── scripts/
│   ├── postinst.sh          # Runs after install (systemd, lockdown, auto-login)
│   ├── prerm.sh             # Runs before uninstall (stops service)
│   └── postrm.sh           # Runs after uninstall (cleanup)
├── setup-raspberry-pi.sh    # Legacy manual setup script
├── update-url.sh            # Change the loaded URL
├── emergency-exit.sh        # Stop kiosk for maintenance
└── README.md                # This file
```
