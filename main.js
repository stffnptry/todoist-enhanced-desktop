const {
  app, BrowserWindow, Menu, Notification, globalShortcut, ipcMain, nativeTheme, shell,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

/* Deutsche Ausgabe: Die Web-App liegt gebaut (mit deutscher Übersetzung) im
   Ordner web/ und wird von einem kleinen Server nur auf diesem Rechner unter
   http://localhost:5192/ ausgeliefert. Diese Adresse steht in der offiziellen
   OAuth-Beschreibung der App, daher funktioniert "Mit Todoist verbinden".
   ENHANCED_URL lädt stattdessen eine andere Adresse direkt. */
// ENHANCED_PORT nur für Tests: die Anmeldung mit Todoist braucht 5192.
const LOCAL_PORT = Number(process.env.ENHANCED_PORT) || 5192;
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

/* ---------- Erscheinungsbild ----------
   Das Hauptfenster trägt das macOS-Material „Seitenleiste“ (Vibrancy). Das
   Material folgt immer dem macOS-Design; zeigt die App ein anderes (z. B.
   dunkel bei hellem macOS) oder ist „Transparenz reduzieren“ an, bekommt das
   Fenster stattdessen eine feste Farbe passend zur App. Das zuletzt gezeigte
   Design wird gespeichert, damit das Fenster beim Start nicht erst in der
   falschen Farbe aufblitzt. In die Designwahl der App greift die Hülle nicht
   ein (nativeTheme.themeSource bleibt "system"). */
const SCHEMES = new Set(['light', 'dark']);

function stateFile() {
  return path.join(app.getPath('userData'), 'window.json');
}

function readSavedScheme() {
  try {
    const { scheme } = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return SCHEMES.has(scheme) ? scheme : null;
  } catch {
    return null;
  }
}

function saveScheme(scheme) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ scheme }));
  } catch {
    /* nicht wichtig genug, um zu stören */
  }
}

let pageScheme = null;
const systemScheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
const useVibrancy = () => process.platform === 'darwin'
  && !nativeTheme.prefersReducedTransparency
  && (pageScheme === null || pageScheme === systemScheme());
// Die Farben des Fensterrands der Web-App (--frame-app), hell und dunkel.
const solidBackground = () => ((pageScheme ?? systemScheme()) === 'dark' ? '#101012' : '#f5f5f5');

/** Was die Seite über das System wissen muss, als Klassen auf <html>. */
function desktopEnv() {
  return {
    vibrant: useVibrancy(),
    reduceTransparency: nativeTheme.prefersReducedTransparency,
    moreContrast: nativeTheme.shouldUseHighContrastColors,
  };
}

function applyMaterial() {
  if (main) {
    if (useVibrancy()) {
      main.setVibrancy('sidebar');
      main.setBackgroundColor('#00000000');
    } else {
      main.setVibrancy(null);
      main.setBackgroundColor(solidBackground());
    }
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:env', desktopEnv());
}

let main = null;
let quick = null;
let quitting = false;
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
    // Auch die Systemeinstellungen (Kalenderzugriff) dürfen geöffnet werden.
    if (/^https?:/.test(url) || url.startsWith('x-apple.systempreferences:')) shell.openExternal(url);
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
    ...(useVibrancy()
      ? { vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
      : { backgroundColor: solidBackground() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  guardNavigation(main);
  main.loadURL(APP_URL);
  /* Schließen blendet das Fenster nur aus: Die Seite liest weiter von Todoist,
     damit die Mitteilungen zu fälligen Aufgaben aktuell bleiben. Beenden
     (⌘Q) schließt es wirklich. */
  main.on('close', (event) => {
    if (quitting || process.platform !== 'darwin') return;
    event.preventDefault();
    main.hide();
  });
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
  /* macOS versteckt die App nach app.hide() verzögert. Kommt der nächste
     Tastendruck genau in diesem Moment, würde das Verstecken das gerade
     geöffnete Fenster wieder schlucken: dann kurz warten. */
  const sinceHide = Date.now() - appHiddenAt;
  if (sinceHide < 250) {
    setTimeout(showQuick, 250 - sinceHide);
    return;
  }
  if (!quick) createQuick();
  mainWasFocused = Boolean(main && main.isFocused());
  if (quickLoadedAt && Date.now() - quickLoadedAt > QUICK_MAX_AGE_MS) {
    quickLoadedAt = 0;
    quick.webContents.once('did-finish-load', showQuick);
    quick.webContents.reloadIgnoringCache();
    return;
  }
  quickShownAt = Date.now();
  if (quickHiding) {
    // Erneut gerufen, während es ausblendet: von der aktuellen Deckkraft zurück.
    quickHiding = false;
  } else if (!quick.isVisible()) {
    quick.setOpacity(0);
    quick.center();
    quick.show();
  }
  quick.focus();
  quick.webContents.send('quickadd:show');
  fadeQuick(1, 140);
}

/* Wie Spotlight blendet das Schnellerfassen kurz ein und aus, statt hart zu
   erscheinen. Jede Blende startet bei der aktuellen Deckkraft, eine neue
   ersetzt die laufende: ein zweiter Tastendruck mitten im Ausblenden holt das
   Fenster ohne Sprung zurück. Eine reine Blende ist auch mit „Bewegung
   reduzieren“ angemessen. */
let quickFade = null;
let quickHiding = false;
let appHiddenAt = 0;

function fadeQuick(to, ms, done) {
  clearInterval(quickFade);
  const from = quick.getOpacity();
  const start = Date.now();
  quickFade = setInterval(() => {
    if (!quick) {
      clearInterval(quickFade);
      return;
    }
    const t = Math.min(1, (Date.now() - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    quick.setOpacity(from + (to - from) * eased);
    if (t < 1) return;
    clearInterval(quickFade);
    quickFade = null;
    if (done) done();
  }, 16);
}

function hideQuick() {
  if (!quick || !quick.isVisible() || quickHiding) return;
  quickHiding = true;
  fadeQuick(0, 110, () => {
    if (!quickHiding) return;
    quickHiding = false;
    quick.hide();
    // Give the keyboard back to the app that was in front, unless this one was.
    if (process.platform === 'darwin' && !mainWasFocused) {
      appHiddenAt = Date.now();
      app.hide();
    }
  });
}

function toggleQuick() {
  if (quick && quick.isVisible() && !quickHiding) hideQuick();
  else showQuick();
}

/* ---------- Mitteilungen zu fälligen Aufgaben ----------
   Die Seite im Hauptfenster schickt die Liste der kommenden Erinnerungen,
   jedes Mal wenn sich die Daten ändern. Hier wird jede zu ihrem Zeitpunkt als
   macOS-Mitteilung gezeigt; ein Klick öffnet die Aufgabe. Was schon gezeigt
   wurde, kommt nicht noch einmal, auch wenn die Liste erneut eintrifft. */
const REMINDER_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const reminderTimers = new Map();
const shownReminders = new Set();
// Gezeigte Mitteilungen festhalten, sonst räumt der Speicher sie ab und der Klick geht ins Leere.
const liveNotifications = new Set();

function showMainWindow() {
  if (!main) createMain();
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function openTaskInMain(itemId) {
  showMainWindow();
  const send = () => main && main.webContents.send('desktop:open-task', itemId);
  // Ein frisch geöffnetes Fenster braucht einen Moment, bis die App bereit ist.
  if (main.webContents.isLoading()) main.webContents.once('did-finish-load', () => setTimeout(send, 1500));
  else send();
}

function showReminder(reminder) {
  if (shownReminders.has(reminder.key) || !Notification.isSupported()) return;
  shownReminders.add(reminder.key);
  const notification = new Notification({ title: reminder.title, body: reminder.body });
  liveNotifications.add(notification);
  const forget = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    openTaskInMain(reminder.itemId);
  });
  notification.on('close', forget);
  notification.show();
}

function scheduleReminders(list) {
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  if (!Array.isArray(list)) return;
  const now = Date.now();
  for (const r of list) {
    if (!r || typeof r.key !== 'string' || typeof r.itemId !== 'string' || typeof r.at !== 'number') continue;
    if (shownReminders.has(r.key) || r.at > now + REMINDER_HORIZON_MS) continue;
    const reminder = { key: r.key, itemId: r.itemId, title: String(r.title || app.name), body: String(r.body || '') };
    reminderTimers.set(r.key, setTimeout(() => {
      reminderTimers.delete(r.key);
      showReminder(reminder);
    }, Math.max(0, r.at - now)));
  }
}

/* ---------- Kalender (macOS, EventKit) ----------
   Ein kleines Hilfsprogramm (native/calhelper.swift) liest und schreibt die
   Kalender, die in der Kalender-App des Macs eingerichtet sind. macOS fragt
   beim ersten Zugriff einmal nach der Erlaubnis. */
const CALHELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'calhelper')
  : path.join(__dirname, 'build', 'native', 'calhelper');
const CAL_COMMANDS = new Set(['status', 'access', 'calendars', 'events', 'create', 'update', 'delete', 'create-calendar']);

/* Nur für Tests (ENHANCED_FAKE_CALENDAR=1): Beispielkalender statt des echten
   Kalenders, damit Testbauten macOS nicht jedes Mal um Erlaubnis fragen. */
const fakeEvents = [];
let fakeSeeded = false;
function fakeCalendar(command, input) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const at = (d, h, m = 0) => new Date(day.getTime() + d * 864e5 + (h * 60 + m) * 6e4).toISOString();
  if (!fakeSeeded) {
    fakeSeeded = true;
    fakeEvents.push(
      { id: 'e1', calendarId: 'work', title: 'Daily', start: at(0, 9), end: at(0, 9, 15), allDay: false, location: '', notes: '', url: '' },
      { id: 'e2', calendarId: 'work', title: 'Workshop', start: at(1, 13), end: at(1, 15), allDay: false, location: 'Raum 2', notes: '', url: '' },
      { id: 'e3', calendarId: 'work', title: 'Urlaub', start: at(3, 0), end: at(5, 0), allDay: true, location: '', notes: '', url: '' },
      { id: 'mine', calendarId: 'tasks', title: 'Eigener Termin', start: at(2, 10), end: at(2, 11), allDay: false, location: '', notes: '', url: '' },
    );
  }
  const calendars = [
    { id: 'work', title: 'Arbeit', color: '#e8731c', source: 'Exchange', writable: false, subscribed: true },
    { id: 'tasks', title: 'Todoist', color: '#4b8430', source: 'Google', writable: true, subscribed: false },
  ];
  if (command !== 'status' && command !== 'calendars' && command !== 'events') console.log('FAKECAL', command, JSON.stringify(input));
  switch (command) {
    case 'status': case 'access': return { ok: true, granted: true, status: 'granted', fake: true };
    case 'calendars': return { ok: true, calendars };
    case 'events': {
      const ids = input && Array.isArray(input.calendars) && input.calendars.length ? input.calendars : null;
      return { ok: true, events: fakeEvents.filter((e) => !ids || ids.includes(e.calendarId)) };
    }
    case 'create': {
      const id = `fake-${fakeEvents.length + 1}`;
      fakeEvents.push({ id, calendarId: input.calendar, title: input.title, start: input.start, end: input.end, allDay: false, location: '', notes: input.notes || '', url: input.url || '' });
      return { ok: true, id };
    }
    case 'update': {
      const e = fakeEvents.find((x) => x.id === input.id);
      if (!e) return { ok: false, error: 'event not found' };
      Object.assign(e, ...['start', 'end', 'title'].filter((k) => input[k] !== undefined).map((k) => ({ [k]: input[k] })));
      return { ok: true };
    }
    case 'delete': {
      const i = fakeEvents.findIndex((x) => x.id === input.id);
      if (i >= 0) fakeEvents.splice(i, 1);
      return { ok: i >= 0 };
    }
    default: return { ok: true };
  }
}

function calendarCall(command, input) {
  if (process.env.ENHANCED_FAKE_CALENDAR === '1') return Promise.resolve(fakeCalendar(command, input));
  return new Promise((resolve) => {
    if (!CAL_COMMANDS.has(command)) {
      resolve({ ok: false, error: 'unknown command' });
      return;
    }
    const args = input === undefined ? [command] : [command, JSON.stringify(input)];
    execFile(CALHELPER, args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
      } catch {
        resolve({ ok: false, error: error ? error.message : 'no answer' });
      }
    });
  });
}

/* ---------- Claude (über die installierte Claude-CLI) ----------
   Die Seite schickt eine Nachricht samt Kontext (Aufgaben, Termine, Regeln);
   hier läuft `claude -p` mit dem Abo der angemeldeten CLI, ohne Werkzeuge,
   ohne MCP und ohne die eigenen Einstellungen (Hooks, Plugins), in einem
   eigenen Ordner. Die Antwort kommt Stück für Stück zurück. Eine Unterhaltung
   wird über ihre Sitzungs-ID fortgesetzt. */
const CLAUDE_CANDIDATES = [
  process.env.CLAUDE_PATH,
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
].filter(Boolean);
const claudeRuns = new Map();

function claudeBinary() {
  return CLAUDE_CANDIDATES.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

/* Eigene Regeln für Claude (regeln.md, frei formuliert, z. B. Planungsgewohnheiten).
   Zuerst aus iCloud Drive, damit sie auf allen Macs gleich sind, sonst aus dem
   Datenordner der App. Wird bei jeder Nachricht neu gelesen: Änderungen gelten sofort. */
const CLAUDE_RULES_FILES = [
  path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Enhanced for Todoist', 'regeln.md'),
  path.join(app.getPath('userData'), 'claude', 'regeln.md'),
];

function claudeRules() {
  for (const file of CLAUDE_RULES_FILES) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text.slice(0, 20_000);
    } catch {
      // Datei fehlt oder ist (noch) nicht aus iCloud geladen: nächste versuchen.
    }
  }
  return '';
}

function claudeAsk(sender, { requestId, message, system, sessionId }) {
  const send = (payload) => { if (!sender.isDestroyed()) sender.send('claude:event', { requestId, ...payload }); };
  const binary = claudeBinary();
  if (!binary) {
    send({ type: 'error', error: 'not-installed' });
    return;
  }
  const cwd = path.join(app.getPath('userData'), 'claude');
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    '-p', String(message),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--strict-mcp-config', '--setting-sources', '',
  ];
  const rules = claudeRules();
  const prompt = [
    system ? String(system) : '',
    rules ? `Rules from the user (their file regeln.md). Always follow them when planning; they take precedence over the defaults above:\n\n${rules}` : '',
  ].filter(Boolean).join('\n\n');
  if (prompt) args.push('--append-system-prompt', prompt);
  if (sessionId && /^[\w-]+$/.test(sessionId)) args.push('--resume', sessionId);
  const child = spawn(binary, args, { cwd, env: { ...process.env, HOME: os.homedir() }, stdio: ['ignore', 'pipe', 'pipe'] });
  claudeRuns.set(requestId, child);
  let buffer = '';
  let errors = '';
  let finished = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
        send({ type: 'delta', text: event.event.delta.text });
      } else if (event.type === 'result') {
        finished = true;
        if (event.is_error) send({ type: 'error', error: String(event.result || event.subtype || 'error'), sessionId: event.session_id });
        else send({ type: 'done', text: String(event.result ?? ''), sessionId: event.session_id });
      }
    }
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.on('error', (error) => { finished = true; send({ type: 'error', error: error.message }); });
  child.on('close', (code) => {
    claudeRuns.delete(requestId);
    if (!finished) send({ type: code === null ? 'cancelled' : 'error', error: errors.trim().slice(-500) || `exit ${code}` });
  });
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
  app.on('second-instance', showMainWindow);
  app.on('before-quit', () => { quitting = true; });

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
    pageScheme = readSavedScheme();
    buildMenu();
    createMain();
    createQuick();
    registerShortcut();
    ipcMain.on('quickadd:hide', hideQuick);
    ipcMain.on('desktop:env', (event) => { event.returnValue = desktopEnv(); });
    ipcMain.handle('calendar', (_event, command, input) => calendarCall(command, input));
    ipcMain.handle('claude:available', () => claudeBinary() !== null);
    ipcMain.on('claude:ask', (event, request) => {
      if (main && event.sender === main.webContents && request && typeof request.requestId === 'string') claudeAsk(event.sender, request);
    });
    ipcMain.on('claude:cancel', (_event, requestId) => claudeRuns.get(requestId)?.kill());
    ipcMain.on('desktop:reminders', (event, list) => {
      if (main && event.sender === main.webContents) scheduleReminders(list);
    });
    // Das Hauptfenster meldet, welches Design es gerade zeigt.
    ipcMain.on('desktop:scheme', (event, scheme) => {
      if (!main || event.sender !== main.webContents || !SCHEMES.has(scheme) || scheme === pageScheme) return;
      pageScheme = scheme;
      saveScheme(scheme);
      applyMaterial();
    });
    // Systemeinstellungen (Transparenz, Kontrast, Design) ändern sich live.
    nativeTheme.on('updated', applyMaterial);
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
