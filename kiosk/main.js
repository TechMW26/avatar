const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, screen } = require("electron");
const { exec, execSync } = require("child_process");
const path = require("path");
const net = require("net");

// ── Configuration ──
const APP_URL = process.env.ALGAETREE_URL || "https://algaetree.vercel.app/";
const CONNECTIVITY_CHECK_INTERVAL = 5000; // 5 seconds
const CONNECTIVITY_CHECK_URL = "https://www.google.com";

let mainWindow = null;
let backWindow = null;
let dualDisplayEnabled = false;
let isOffline = false;
let connectivityTimer = null;
let powerBlockerId = null;

function checkInternet() {
  return new Promise((resolve) => {
    const https = require("https");
    const url = new URL(CONNECTIVITY_CHECK_URL);
    const req = https.get(
      { hostname: url.hostname, port: 443, path: "/", timeout: 5000 },
      (res) => {
        res.destroy();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getWifiNetworks() {
  try {
    const output = execSync(
      'nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list 2>/dev/null || echo ""',
      { encoding: "utf8", timeout: 10000 }
    );
    if (!output.trim()) return [];
    const seen = new Set();
    return output
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split(":");
        return {
          ssid: parts[0] || "",
          signal: parseInt(parts[1]) || 0,
          security: parts[2] || "Open",
        };
      })
      .filter((n) => {
        if (!n.ssid || seen.has(n.ssid)) return false;
        seen.add(n.ssid);
        return true;
      })
      .sort((a, b) => b.signal - a.signal);
  } catch {
    return [];
  }
}

function connectToWifi(ssid, password) {
  return new Promise((resolve) => {
    const cmd = password
      ? `nmcli dev wifi connect "${ssid.replace(/"/g, '\\"')}" password "${password.replace(/"/g, '\\"')}" 2>&1`
      : `nmcli dev wifi connect "${ssid.replace(/"/g, '\\"')}" 2>&1`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, message: stderr || stdout || err.message });
      } else {
        resolve({ success: true, message: "Connected successfully" });
      }
    });
  });
}

function createKioskWindow(display) {
  const { x, y, width, height } = display.bounds;
  const window = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#060b14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.setMenu(null);
  window.setMenuBarVisibility(false);

  // Prevent window from being closed
  window.on("close", (e) => {
    e.preventDefault();
  });

  // Ensure fullscreen is always on
  window.on("leave-full-screen", () => {
    window.setFullScreen(true);
  });

  // Disable dev tools in production
  window.webContents.on("devtools-opened", () => {
    window.webContents.closeDevTools();
  });

  // Disable all navigation away from app
  window.webContents.on("will-navigate", (e, url) => {
    const allowedOrigin = new URL(APP_URL).origin;
    if (!url.startsWith(allowedOrigin) && !url.startsWith("file://")) {
      e.preventDefault();
    }
  });

  // Disable new window creation
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Handle page load errors (offline)
  window.webContents.on("did-fail-load", () => {
    loadOfflinePage(window);
  });

  return window;
}

function resolveDisplay(displays, configured, fallback) {
  if (configured == null || configured === "") return fallback;
  const value = String(configured).trim();
  if (value.startsWith("id:")) {
    const displayId = Number(value.slice(3));
    return displays.find((display) => display.id === displayId) || fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return displays[numeric] || fallback;
}

function buildRoleUrl(role) {
  const url = new URL(APP_URL);
  if (!dualDisplayEnabled) return url.toString();

  url.searchParams.set("dual", "1");
  if (role === "back") {
    url.pathname = /\/talk\/?$/.test(url.pathname)
      ? url.pathname.replace(/\/talk\/?$/, "/talk/back")
      : `${url.pathname.replace(/\/$/, "")}/talk/back`;
    const cvCamera = process.env.ALGAETREE_CV_CAMERA || "index:1";
    url.searchParams.set("camera", cvCamera);
  } else {
    const frontCamera = process.env.ALGAETREE_FRONT_CAMERA || "index:0";
    url.searchParams.set("camera", frontCamera);
  }
  return url.toString();
}

function createWindow() {
  const displays = screen
    .getAllDisplays()
    .slice()
    .sort((left, right) => left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y);
  const primary = screen.getPrimaryDisplay();
  const frontDisplay = resolveDisplay(displays, process.env.ALGAETREE_FRONT_DISPLAY, primary);
  const backFallback = displays.find((display) => display.id !== frontDisplay.id) || null;
  const backDisplay = resolveDisplay(displays, process.env.ALGAETREE_BACK_DISPLAY, backFallback);

  dualDisplayEnabled = Boolean(backDisplay && backDisplay.id !== frontDisplay.id);
  mainWindow = createKioskWindow(frontDisplay);
  // The rear display is normally opened once by the operator at the stable
  // `/talk/back` URL. Never create a surprise window when a character starts.
  // Set this explicit kiosk-only flag to retain the legacy auto-launch mode.
  if (dualDisplayEnabled && process.env.ALGAETREE_AUTO_OPEN_BACK === "1") {
    backWindow = createKioskWindow(backDisplay);
  }

  // Start connectivity monitoring
  startConnectivityCheck();

  // Initial load
  loadApp();
}

async function loadApp() {
  const online = await checkInternet();
  if (online) {
    isOffline = false;
    const loads = [];
    if (mainWindow && !mainWindow.isDestroyed()) {
      loads.push(mainWindow.loadURL(buildRoleUrl("front")));
    }
    if (backWindow && !backWindow.isDestroyed()) {
      loads.push(backWindow.loadURL(buildRoleUrl("back")));
    }
    await Promise.allSettled(loads);
  } else {
    loadOfflinePage(mainWindow);
    loadOfflinePage(backWindow);
  }
}

function loadOfflinePage(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  isOffline = true;
  const networks = getWifiNetworks();
  targetWindow.loadFile(path.join(__dirname, "offline.html")).then(() => {
    targetWindow.webContents.executeJavaScript(
      `window.__setNetworks(${JSON.stringify(networks)})`
    );
  }).catch(() => {});
}

function startConnectivityCheck() {
  if (connectivityTimer) clearInterval(connectivityTimer);
  connectivityTimer = setInterval(async () => {
    const online = await checkInternet();
    if (online && isOffline) {
      isOffline = false;
      loadApp();
    } else if (!online && !isOffline) {
      loadOfflinePage(mainWindow);
      loadOfflinePage(backWindow);
    }
  }, CONNECTIVITY_CHECK_INTERVAL);
}

function blockShortcuts() {
  const blockedShortcuts = [
    "Alt+F4",
    "CommandOrControl+Q",
    "CommandOrControl+W",
    "CommandOrControl+R",
    "CommandOrControl+Shift+I",
    "CommandOrControl+Shift+J",
    "F5",
    "F11",
    "F12",
    "Alt+Tab",
    "Super",
    "CommandOrControl+T",
    "CommandOrControl+N",
    "CommandOrControl+Shift+N",
    "CommandOrControl+L",
    "Escape",
  ];
  blockedShortcuts.forEach((shortcut) => {
    try {
      globalShortcut.register(shortcut, () => {});
    } catch {
      // Some shortcuts may not be registerable on all platforms
    }
  });
}

// ── IPC handling for WiFi operations from preload ──
const { ipcMain } = require("electron");

ipcMain.handle("wifi:scan", () => {
  return getWifiNetworks();
});

ipcMain.handle("wifi:connect", async (_event, ssid, password) => {
  return connectToWifi(ssid, password);
});

ipcMain.handle("wifi:check-internet", () => {
  return checkInternet();
});

// ── App lifecycle ──
app.whenReady().then(() => {
  // Prevent power saving / screen blanking
  powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");

  // Set permissions for microphone and camera (needed for voice conversation and vision detection)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "microphone", "camera", "audioCapture", "videocapture"];
      callback(allowed.includes(permission));
    }
  );

  createWindow();
  blockShortcuts();
});

// Keep the app running no matter what
app.on("window-all-closed", (e) => {
  e.preventDefault();
});

// Re-register shortcuts when app regains focus
app.on("browser-window-focus", () => {
  blockShortcuts();
});

// Handle uncaught exceptions - restart the window
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  if (mainWindow) {
    try {
      loadApp();
    } catch {
      // Last resort
    }
  }
});
