const { app, BrowserWindow, Menu, Tray } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONSOLE_URL = "http://127.0.0.1:17677/console";
const consoleUrl = process.env.SYNREX_CONSOLE_URL || DEFAULT_CONSOLE_URL;
const allowed = new URL(consoleUrl);
let win = null;
let tray = null;

function isAllowedNavigation(raw) {
  try {
    const url = new URL(raw);
    return url.origin === allowed.origin && (url.pathname === "/console" || url.pathname.startsWith("/console/"));
  } catch {
    return false;
  }
}

async function appIcon() {
  const packaged = path.join(__dirname, "Synrex.ico");
  if (fs.existsSync(packaged)) return packaged;
  try {
    const executableIcon = await app.getFileIcon(process.execPath, { size: "normal" });
    return executableIcon.isEmpty() ? undefined : executableIcon;
  } catch {
    return undefined;
  }
}

async function createWindow(icon) {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Synrex Console",
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedNavigation(target)) event.preventDefault();
  });
  win.on("close", event => {
    if (!app.isQuiting) { event.preventDefault(); win.hide(); }
  });
  await win.loadURL(consoleUrl);
  win.show();
}

function createTray(icon) {
  if (!icon) return;
  tray = new Tray(icon);
  tray.setToolTip("Synrex Console");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Synrex Console", click: () => { win?.show(); win?.focus(); } },
    { type: "separator" },
    { label: "Quit Synrex Console", click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { win?.show(); win?.focus(); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName("Synrex Console");
  app.on("second-instance", () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    const icon = await appIcon();
    await createWindow(icon);
    createTray(icon);
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => { app.isQuiting = true; });
}
