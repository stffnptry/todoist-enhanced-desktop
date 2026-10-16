const {
  app, BrowserWindow, Menu, Notification, globalShortcut, ipcMain, shell,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/* Deutsche Ausgabe: Die Web-App liegt gebaut (mit deutscher Übersetzung) im
   Ordner web/ und wird von einem kleinen Server nur auf diesem Rechner unter
   http://localhost:5192/ ausgeliefert. Diese Adresse steht in der offiziellen
   OAuth-Beschreibung der App, daher funktioniert "Mit Todoist verbinden".
   ENHANCED_URL lädt stattdessen eine andere Adresse direkt. */
const LOCAL_PORT = 5192;
const APP_URL = (process.env.ENHANCED_URL || `http://localhost:${LOCAL_PORT}/`).trim();
const APP_ORIGIN = new URL(APP_URL).origin;
const WEB_ROOT = path.join(__dirname, 'web');
const SERVE_LOCAL = !process.env.ENHANCED_URL;

// Oberfläche auf Deutsch: navigator.language wird "de", die Web-App wählt
// beim ersten Start Deutsch.
app.commandLine.appendSwitch('lang', 'de');

// Für Tests: ein eigener Datenordner, damit eine laufende App nicht stört.
if (process.env.ENHANCED_USER_DATA) app.setPath('userData', process.env.ENHANCED_USER_DATA);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Beantwortet eine Anfrage mit den Dateien aus web/. */
function serveFromBundle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, APP_URL).pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // Kein Service Worker: die Dateien liegen ohnehin lokal.
  if (pathname === '/registerSW.js' || pathname === '/sw.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] }).end('');
    return;
  }
  let file = path.normalize(path.join(WEB_ROOT, pathname));
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(404).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Eine Seite der App (Ansicht, OAuth-Rückkehr): index.html beantwortet alle.
    if (path.extname(pathname)) {
      res.writeHead(404).end();
      return;
    }
    file = path.join(WEB_ROOT, 'index.html');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
}

/** Startet den lokalen Server; nur von diesem Rechner aus erreichbar. */
function startLocalSite() {
  if (!SERVE_LOCAL) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveFromBundle);
    server.once('error', reject);
    server.listen(LOCAL_PORT, '127.0.0.1', resolve);
  });
}

/* Shift+Control+Option+Command+T (⇧⌃⌥⌘T) by default. This side reads
   `quickAddShortcut` from config.json in the app's data folder (Electron
   accelerator syntax, e.g. "Alt+Shift+Space"), or QUICKADD_SHORTCUT. */
function readShortcut() {
  if (process.env.QUICKADD_SHORTCUT) return process.env.QUICKADD_SHORTCUT;
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).quickAddShortcut || 'Shift+Control+Alt+Command+T';
  } catch {
    return 'Shift+Control+Alt+Command+T';
  }
}

let main = null;
let quick = null;
let mainWasFocused = false;
let quickLoadedAt = 0;
let quickShownAt = 0;

/* The quick-add window is created once and kept hidden, so without this it
   keeps showing whatever version of the site it loaded when the app started:
   after a release it would still be the old composer until the app is
   restarted. A page older than this is loaded again before it is shown. */
const QUICK_MAX_AGE_MS = 10 * 60 * 1000;

/** Todoist's own pages (sign-in) may load in the window; everything else opens in the browser. */
function isOurs(url) {
  try {
    const { origin, hostname } = new URL(url);
    return origin === APP_ORIGIN || hostname === 'todoist.com' || hostname.endsWith('.todoist.com');
  } catch {
    return false;
  }
}

function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function createMain() {
  main = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  guardNavigation(main);
  main.loadURL(APP_URL);
  main.on('closed', () => { main = null; });
}

function createQuick() {
  quick = new BrowserWindow({
    /* Wider than the composer (660): the window is transparent and clips what
       is drawn outside it, so the composer's shadow, which reaches about 56px
       to each side, needs that much room or it is cut off in a straight line. */
    width: 820,
    height: 680,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    /* A panel on macOS does not bring the app's other windows to the front
       when it opens: without it, the shortcut raised the whole app behind the
       composer instead of the composer alone. */
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  /* Over other apps' full-screen windows and on whichever Space is current.
     skipTransformProcessType: sonst macht Electron die App auf macOS zu einer
     Hintergrund-App, und ihr Symbol verschwindet aus dem Dock. */
  quick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  quick.setAlwaysOnTop(true, 'floating');
  guardNavigation(quick);
  quick.loadURL(`${APP_URL}${APP_URL.includes('?') ? '&' : '?'}quickadd`);
  quick.webContents.on('did-finish-load', () => { quickLoadedAt = Date.now(); });
  // Like Spotlight: clicking elsewhere puts it away.
  quick.on('blur', () => hideQuick());
  quick.on('closed', () => { quick = null; });
}

function showQuick() {
  if (!quick) createQuick();
  mainWasFocused = Boolean(main && main.isFocused());
  if (quickLoadedAt && Date.now() - quickLoadedAt > QUICK_MAX_AGE_MS) {
    quickLoadedAt = 0;
    quick.webContents.once('did-finish-load', showQuick);
    quick.webContents.reloadIgnoringCache();
    return;
  }
  quickShownAt = Date.now();
  quick.center();
  quick.show();
  quick.focus();
  quick.webContents.send('quickadd:show');
}

function hideQuick() {
  if (!quick || !quick.isVisible()) return;
  quick.hide();
  // Give the keyboard back to the app that was in front, unless this one was.
  if (process.platform === 'darwin' && !mainWasFocused) app.hide();
}

function toggleQuick() {
  if (quick && quick.isVisible()) hideQuick();
  else showQuick();
}

function registerShortcut() {
  const accelerator = readShortcut();
  const ok = globalShortcut.register(accelerator, toggleQuick);
  if (!ok) {
    new Notification({
      title: app.name,
      body: `${accelerator} wird bereits von einer anderen App verwendet. ` +
        'Lege in config.json ein anderes Kürzel fest: { "quickAddShortcut": "Alt+Shift+Space" }.',
    }).show();
  }
}

function buildMenu() {
  const name = app.name;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: 'about', label: `Über ${name}` },
        { type: 'separator' },
        { role: 'services', label: 'Dienste' },
        { type: 'separator' },
        { role: 'hide', label: `${name} ausblenden` },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: `${name} beenden` },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'pasteAndMatchStyle', label: 'Einsetzen und Stil anpassen' },
        { role: 'delete', label: 'Löschen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: 'Darstellung',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'forceReload', label: 'Neu laden erzwingen' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbildmodus' },
      ],
    },
    {
      label: 'Fenster',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: 'Im Dock ablegen' },
        { role: 'zoom', label: 'Zoomen' },
        { type: 'separator' },
        { role: 'front', label: 'Alle nach vorne bringen' },
        { type: 'separator' },
        { role: 'close', label: 'Fenster schließen' },
      ],
    },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!main) createMain();
    else { if (main.isMinimized()) main.restore(); main.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      await startLocalSite();
    } catch (error) {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        `${app.name} kann nicht starten`,
        `Port ${LOCAL_PORT} auf diesem Rechner ist bereits belegt (${error.code || error.message}). ` +
          'Beende das Programm, das ihn nutzt, und öffne die App erneut.',
      );
      app.quit();
      return;
    }
    buildMenu();
    createMain();
    createQuick();
    registerShortcut();
    ipcMain.on('quickadd:hide', hideQuick);
    /* Showing the quick-add window activates the app, and macOS reports that
       as a Dock click: left alone, the main window would be brought up (or
       opened again, if it was closed) behind every shortcut press. */
    app.on('activate', () => {
      if (quick && (quick.isVisible() || Date.now() - quickShownAt < 1000)) return;
      if (!main) createMain(); else main.show();
    });
  });

  // The shortcut has to keep working with the main window closed.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
