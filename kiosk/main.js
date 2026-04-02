const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker } = require("electron");
const { exec, execSync } = require("child_process");
const path = require("path");
const net = require("net");

// ── Configuration ──
const APP_URL = process.env.ALGAETREE_URL || "https://algaetree.vercel.app/talk";
const CONNECTIVITY_CHECK_INTERVAL = 5000; // 5 seconds
const CONNECTIVITY_CHECK_URL = "https://www.google.com";

let mainWindow = null;
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

function createWindow() {
  mainWindow = new BrowserWindow({
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

  // Block all exit/navigation shortcuts
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  // Prevent window from being closed
  mainWindow.on("close", (e) => {
    e.preventDefault();
  });

  // Ensure fullscreen is always on
  mainWindow.on("leave-full-screen", () => {
    mainWindow.setFullScreen(true);
  });

  // Disable dev tools in production
  mainWindow.webContents.on("devtools-opened", () => {
    mainWindow.webContents.closeDevTools();
  });

  // Disable all navigation away from app
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith("file://")) {
      e.preventDefault();
    }
  });

  // Disable new window creation
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Handle page load errors (offline)
  mainWindow.webContents.on("did-fail-load", () => {
    loadOfflinePage();
  });

  // Start connectivity monitoring
  startConnectivityCheck();

  // Initial load
  loadApp();
}

async function loadApp() {
  const online = await checkInternet();
  if (online) {
    isOffline = false;
    mainWindow.loadURL(APP_URL);
  } else {
    loadOfflinePage();
  }
}

function loadOfflinePage() {
  isOffline = true;
  const networks = getWifiNetworks();
  mainWindow.loadFile(path.join(__dirname, "offline.html")).then(() => {
    mainWindow.webContents.executeJavaScript(
      `window.__setNetworks(${JSON.stringify(networks)})`
    );
  });
}

function startConnectivityCheck() {
  if (connectivityTimer) clearInterval(connectivityTimer);
  connectivityTimer = setInterval(async () => {
    const online = await checkInternet();
    if (online && isOffline) {
      isOffline = false;
      mainWindow.loadURL(APP_URL);
    } else if (!online && !isOffline) {
      loadOfflinePage();
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
