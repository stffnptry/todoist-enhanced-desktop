const {
  app, BrowserWindow, Menu, Notification, globalShortcut, ipcMain, nativeTheme, screen, shell,
  systemPreferences,
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

/* Shift+Control+Option+Command+E (⇧⌃⌥⌘E) by default. This side reads
   `quickAddShortcut` from config.json in the app's data folder (Electron
   accelerator syntax, e.g. "Alt+Shift+Space"), or QUICKADD_SHORTCUT. */
function readShortcut() {
  if (process.env.QUICKADD_SHORTCUT) return process.env.QUICKADD_SHORTCUT;
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).quickAddShortcut || 'Shift+Control+Alt+Command+E';
  } catch {
    return 'Shift+Control+Alt+Command+E';
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
let mainWasVisible = false;
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
    // Auch die Systemeinstellungen (Kalenderzugriff) und Mail-Links („In Mail öffnen“).
    if (/^https?:/.test(url) || url.startsWith('x-apple.systempreferences:') || /^message:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url) || /^message:/i.test(url)) shell.openExternal(url);
  });
}

/**
 * Rechtsklick in Textfeldern und auf markiertem Text: Ausschneiden, Kopieren,
 * Einfügen, wie überall auf dem Mac. Electron zeigt von sich aus gar nichts.
 * Auf Aufgaben, Projekten usw. öffnet die Seite ihr eigenes Menü und
 * verhindert das Standardereignis – dann kommt hier nichts an.
 */
function textContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const { isEditable, selectionText, editFlags, dictionarySuggestions, misspelledWord } = params;
    const selected = selectionText.trim() !== '';
    if (!isEditable && !selected) return;
    const template = [];
    if (isEditable && misspelledWord) {
      for (const word of dictionarySuggestions.slice(0, 4)) {
        template.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
      }
      if (template.length) template.push({ type: 'separator' });
    }
    if (isEditable) template.push({ role: 'cut', label: 'Ausschneiden', enabled: editFlags.canCut });
    template.push({ role: 'copy', label: 'Kopieren', enabled: editFlags.canCopy });
    if (isEditable) {
      template.push({ role: 'paste', label: 'Einfügen', enabled: editFlags.canPaste });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll', label: 'Alles auswählen', enabled: editFlags.canSelectAll });
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function createMain({ show = true } = {}) {
  main = new BrowserWindow({
    show,
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
  textContextMenu(main);
  main.loadURL(APP_URL);
  /* Schließen blendet das Fenster nur aus: Die Seite liest weiter von Todoist,
     damit die Mitteilungen zu fälligen Aufgaben aktuell bleiben. Beenden
     (⌘Q) schließt es wirklich. */
  main.on('close', (event) => {
    if (quitting || process.platform !== 'darwin') return;
    event.preventDefault();
    main.hide();
  });
  main.on('blur', stopWindowDrag);
  main.on('closed', () => { stopWindowDrag(); main = null; });
}

/* Fenster verschieben: Die Seite meldet Maus gedrückt/losgelassen im Kopf
   (preload.js), hier folgt das Fenster dem Mauszeiger. Ersetzt die
   CSS-Zieh-Flächen (-webkit-app-region), die am Mac nur unzuverlässig griffen. */
let windowDrag = null;
function startWindowDrag(win) {
  stopWindowDrag();
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const start = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  windowDrag = setInterval(() => {
    if (win.isDestroyed()) { stopWindowDrag(); return; }
    const now = screen.getCursorScreenPoint();
    win.setPosition(x + now.x - start.x, y + now.y - start.y);
  }, 8);
}
function stopWindowDrag() {
  if (windowDrag) clearInterval(windowDrag);
  windowDrag = null;
}
// Doppelklick auf den Kopf wie bei jedem Mac-Fenster (Systemeinstellung „Doppelklick auf Titelleiste“).
function titleBarDoubleClick(win) {
  if (!win || win.isDestroyed()) return;
  const action = process.platform === 'darwin'
    ? systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') : 'Maximize';
  if (action === 'None') return;
  if (action === 'Minimize') { win.minimize(); return; }
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
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
  textContextMenu(quick);
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
  mainWasVisible = Boolean(main && main.isVisible() && !main.isMinimized());
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
    /* Give the keyboard back to the app that was in front, unless this one was.
       app.hide() versteckt aber alle Fenster der App, also auch ein sichtbares
       Hauptfenster – das sah aus, als würde die App ins Dock verschwinden.
       Das Schnellerfassen ist ein Panel (type: 'panel'), das die App beim
       Öffnen nicht aktiviert: die vorherige App behält den Fokus ohnehin.
       Verstecken also nur noch, wenn kein Hauptfenster zu sehen war. */
    if (process.platform === 'darwin' && !mainWasFocused && !mainWasVisible) {
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

/* Knöpfe an der Mitteilung: Erledigt, +15 Min., +1 Std. Die Beschriftung
   schickt die Seite in ihrer Sprache mit; die Reihenfolge steht hier fest.
   macOS zeigt Knöpfe nur bei signierten Apps; den ersten als Knopf, die
   übrigen im Ausklappmenü daneben. Die Seite erledigt bzw. verschiebt die
   Aufgabe, ohne dass sich das Fenster öffnet. */
const REMINDER_ACTIONS = ['done', 'snooze15', 'snooze60'];
const DEFAULT_ACTION_LABELS = ['Erledigt', '+15 Min.', '+1 Std.'];

/* macOS holt die App nach vorn, sobald ein Knopf der Mitteilung gedrückt
   wird, und meldet das als „activate“ – das würde das Hauptfenster zeigen.
   Deshalb merken: Kurz nach einem Knopf bleibt das Fenster, wie es war, und
   die App gibt den Fokus an das vorige Programm zurück. Die Reihenfolge der
   beiden Ereignisse ist nicht fest, daher in beide Richtungen abgesichert. */
const REMINDER_ACTION_QUIET_MS = 2000;
let reminderActionAt = 0;
let activateShownAt = 0;

function quietAfterReminderAction() {
  reminderActionAt = Date.now();
  // „activate“ kam zuerst und hat ein verstecktes Fenster gezeigt: wieder weg.
  if (main && !main.isDestroyed() && Date.now() - activateShownAt < REMINDER_ACTION_QUIET_MS) main.hide();
  const anyVisible = BrowserWindow.getAllWindows().some((w) => w.isVisible());
  if (process.platform === 'darwin' && !anyVisible) app.hide();
}

function sendTaskAction(itemId, action) {
  if (!main) createMain({ show: false });
  const send = () => main && main.webContents.send('desktop:task-action', { itemId, action });
  if (main.webContents.isLoading()) main.webContents.once('did-finish-load', send);
  else send();
}

function showReminder(reminder) {
  if (shownReminders.has(reminder.key) || !Notification.isSupported()) return;
  shownReminders.add(reminder.key);
  const notification = new Notification({
    title: reminder.title,
    body: reminder.body,
    actions: reminder.actions.map((text) => ({ type: 'button', text })),
    closeButtonText: reminder.closeText,
  });
  liveNotifications.add(notification);
  const forget = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    openTaskInMain(reminder.itemId);
  });
  notification.on('action', (_event, index) => {
    forget();
    const action = REMINDER_ACTIONS[index];
    if (!action) return;
    quietAfterReminderAction();
    sendTaskAction(reminder.itemId, action);
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
    const labels = Array.isArray(r.actions) ? r.actions : [];
    const reminder = {
      key: r.key,
      itemId: r.itemId,
      title: String(r.title || app.name),
      body: String(r.body || ''),
      actions: DEFAULT_ACTION_LABELS.map((fallback, i) => String(labels[i] || fallback)),
      closeText: String(r.closeText || 'Schließen'),
    };
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

/* ---------- E-Mails als Aufgaben (Ziehen ins Fenster) ----------
   Die Seite liest, was beim Ablegen mitkommt (siehe web/src/components/MailDrop.tsx).
   Apple Mail gibt nur einen Link „message:<Message-ID>“ mit; Betreff und Text
   holt AppleScript aus Mail (beim ersten Mal fragt macOS, ob die App Mail
   steuern darf). Für Programme, die Chromium nichts Lesbares geben (das neue
   Outlook), schaut JXA auf die Drag-Ablage des Systems: welche Typen dort
   liegen, Datei-Links und Text. */
const APPLE_MAIL_SCRIPT = `on run argv
  set wanted to item 1 of argv
  set sep to (character id 30)
  tell application "Mail"
    set found to missing value
    set picked to {}
    try
      set picked to (get selection)
    end try
    repeat with m in picked
      try
        if (message id of m) is wanted then
          set found to contents of m
          exit repeat
        end if
      end try
    end repeat
    if found is missing value then
      try
        set hits to (messages of inbox whose message id is wanted)
        if (count of hits) > 0 then set found to item 1 of hits
      end try
    end if
    -- Gezogen wird die ausgewählte Mail; passt die ID nicht genau, gilt die eine ausgewählte.
    if found is missing value and (count of picked) is 1 then set found to item 1 of picked
    if found is missing value then return ""
    return (subject of found) & sep & (sender of found) & sep & ((date received of found) as string) & sep & (content of found)
  end tell
end run
`;

const DRAG_PASTEBOARD_SCRIPT = `ObjC.import('AppKit');
function run() {
  const name = $.NSPasteboardNameDrag || 'Apple CFPasteboard drag';
  const pb = $.NSPasteboard.pasteboardWithName(name);
  const out = { types: [], files: [], text: null, html: null };
  const types = pb.types;
  if (types && !types.isNil()) out.types = ObjC.deepUnwrap(types) || [];
  const items = pb.pasteboardItems;
  const count = items && !items.isNil() ? items.count : 0;
  for (let i = 0; i < count; i += 1) {
    const url = items.objectAtIndex(i).stringForType('public.file-url');
    if (url && !url.isNil()) out.files.push(decodeURIComponent(url.js.replace(/^file:\\/\\//, '')));
  }
  const text = pb.stringForType('public.utf8-plain-text');
  if (text && !text.isNil()) out.text = text.js.slice(0, 20000);
  const html = pb.stringForType('public.html');
  if (html && !html.isNil()) out.html = html.js.slice(0, 50000);
  return JSON.stringify(out);
}
`;

/** Ein Skript über osascript, als Datei im Datenordner (Text auf stdout). */
function runScript(script, file, { language = [], args = [] } = {}) {
  return new Promise((resolve) => {
    const target = path.join(app.getPath('userData'), file);
    try { fs.writeFileSync(target, script); } catch (error) { resolve({ ok: false, error: error.message }); return; }
    execFile('/usr/bin/osascript', [...language, target, ...args], { timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: String(stderr || error.message).trim() });
      else resolve({ ok: true, stdout: String(stdout) });
    });
  });
}

async function appleMailMessage(messageId) {
  if (typeof messageId !== 'string' || !messageId) return { ok: false, error: 'no id' };
  const result = await runScript(APPLE_MAIL_SCRIPT, 'apple-mail.applescript', { args: [messageId] });
  if (!result.ok) return result;
  const text = result.stdout.replace(/\n$/, '');
  if (!text) return { ok: false, error: 'not found' };
  const [subject, from, date, ...body] = text.split('\u001e');
  return { ok: true, subject, from, date, body: body.join('\u001e') };
}

async function dragPasteboard() {
  const result = await runScript(DRAG_PASTEBOARD_SCRIPT, 'drag-pasteboard.js', { language: ['-l', 'JavaScript'] });
  if (!result.ok) return result;
  try { return { ok: true, ...JSON.parse(result.stdout) }; } catch { return { ok: false, error: 'no answer' }; }
}

function readEml(file) {
  if (typeof file !== 'string' || !/\.eml$/i.test(file)) return { ok: false, error: 'not an eml file' };
  try {
    if (fs.statSync(file).size > 30 * 1024 * 1024) return { ok: false, error: 'too large' };
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
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

/* Claudes Notizen über den Nutzer, als Markdown im Projektordner (Git-Clone in
   ~/Developer; früher ~/Documents in iCloud, das bleibt als Rückfall); fehlt der
   Ordner, im Datenordner der App. ENHANCED_PROJECT_DIR setzt einen anderen Ort. Alle werden bei jeder Nachricht neu gelesen: Änderungen gelten sofort.
   - regeln.md: schreibt nur der Nutzer selbst.
   - gedaechtnis.md: was Claude sich merken soll; Claude schlägt Einträge nur vor,
     geschrieben wird erst, wenn der Nutzer „merken“ klickt (claude:remember).
   - claude-protokoll.md: welche Vorschläge übernommen oder abgelehnt wurden
     (claude:log), damit Claude Muster erkennen kann. */
const PROJECT_DIRS = [
  process.env.ENHANCED_PROJECT_DIR,
  path.join(os.homedir(), 'Developer', 'Enhanced-for-Todoist-DE'),
  path.join(os.homedir(), 'Documents', 'Claude', 'Coding', 'macOS', 'Enhanced-for-Todoist-DE'),
].filter(Boolean);
const claudeNotesDir = () =>
  PROJECT_DIRS.find((dir) => fs.existsSync(dir)) ?? path.join(app.getPath('userData'), 'claude');
const MEMORY_HEADER = '# Claudes Gedächtnis\n\nWas Claude beim Planen über dich gelernt hat. Du kannst Einträge jederzeit ändern oder löschen.\n\n';
const LOG_HEADER = '# Claude-Protokoll\n\nWelche Vorschläge von Claude du übernommen (✓) oder abgelehnt (✗) hast. Wird automatisch gekürzt.\n\n';

function readNotes(name) {
  for (const dir of [claudeNotesDir(), path.join(app.getPath('userData'), 'claude')]) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
      if (text) return text;
    } catch {
      // Datei fehlt oder ist (noch) nicht aus iCloud geladen: nächsten Ort versuchen.
    }
  }
  return '';
}

/** Hängt Zeilen an eine Notizdatei an (legt sie mit Überschrift an) und behält höchstens `keep` Einträge. */
function appendNotes(name, header, lines, keep) {
  const file = path.join(claudeNotesDir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = header; }
  if (text && !text.endsWith('\n')) text += '\n';
  text += lines.map((line) => `${line}\n`).join('');
  if (keep) {
    const all = text.split('\n');
    const entries = all.filter((line) => line.startsWith('- '));
    if (entries.length > keep) text = header + entries.slice(-keep).join('\n') + '\n';
  }
  fs.writeFileSync(file, text);
}

/** Nur kurze Textzeilen aus der Seite annehmen. */
const cleanLines = (lines, max) => (Array.isArray(lines) ? lines : [])
  .filter((line) => typeof line === 'string')
  .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 500))
  .filter(Boolean)
  .slice(0, max);

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
  const rules = readNotes('regeln.md').slice(0, 20_000);
  const memory = readNotes('gedaechtnis.md').slice(0, 20_000);
  const log = readNotes('claude-protokoll.md').split('\n').filter((line) => line.startsWith('- ')).slice(-80).join('\n');
  const prompt = [
    system ? String(system) : '',
    rules ? `Rules from the user (their file regeln.md). Always follow them when planning; they take precedence over the defaults above:\n\n${rules}` : '',
    memory ? `What you have learned about the user so far (their file gedaechtnis.md; only entries they agreed to). Use it when planning:\n\n${memory}` : '',
    log ? `The user's recent decisions on your proposals (✓ accepted, ✗ declined), oldest first. Look for patterns in them:\n\n${log}` : '',
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

/* Report-Export (Ansicht „Report“): Die Seite liefert fertigen Inhalt, die
   Hülle fragt per Sichern-Dialog nach dem Ort und schreibt die Datei. Für das
   PDF lädt ein unsichtbares Fenster das übergebene HTML (ohne Skripte, ohne
   Netz) und druckt es mit printToPDF. */
function safeFileName(name, ext) {
  const base = String(name || 'Report').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'Report';
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

async function askSavePath(name, ext, label) {
  const { dialog } = require('electron');
  const result = await dialog.showSaveDialog(main, {
    defaultPath: path.join(app.getPath('downloads'), safeFileName(name, ext)),
    filters: [{ name: label, extensions: [ext.slice(1)] }],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function saveReportMarkdown(name, content) {
  if (typeof content !== 'string') return { ok: false };
  const file = await askSavePath(name, '.md', 'Markdown');
  if (!file) return { ok: false, cancelled: true };
  fs.writeFileSync(file, content, 'utf8');
  return { ok: true, path: file };
}

async function saveReportPdf(name, html) {
  if (typeof html !== 'string') return { ok: false };
  const file = await askSavePath(name, '.pdf', 'PDF');
  if (!file) return { ok: false, cancelled: true };
  const printer = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, partition: 'report-print' },
  });
  // Nichts nachladen: der Report bringt alles inline mit. Eigene Sitzung
  // (partition), damit die Sperre das Hauptfenster nicht trifft.
  printer.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, done) => done({ cancel: true }));
  try {
    await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await printer.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    fs.writeFileSync(file, pdf);
    return { ok: true, path: file };
  } finally {
    printer.destroy();
  }
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
    ipcMain.on('window:drag-start', (event) => { if (main && event.sender === main.webContents) startWindowDrag(main); });
    ipcMain.on('window:drag-end', stopWindowDrag);
    ipcMain.on('window:double-click', (event) => { if (main && event.sender === main.webContents) titleBarDoubleClick(main); });
    ipcMain.on('desktop:env', (event) => { event.returnValue = desktopEnv(); });
    ipcMain.handle('calendar', (_event, command, input) => calendarCall(command, input));
    ipcMain.handle('mail:apple', (event, messageId) => (main && event.sender === main.webContents ? appleMailMessage(messageId) : { ok: false }));
    ipcMain.handle('mail:drag', (event) => (main && event.sender === main.webContents ? dragPasteboard() : { ok: false }));
    ipcMain.handle('mail:read-eml', (event, file) => (main && event.sender === main.webContents ? readEml(file) : { ok: false }));
    ipcMain.handle('claude:available', () => claudeBinary() !== null);
    ipcMain.handle('report:save-md', (event, name, content) => (main && event.sender === main.webContents ? saveReportMarkdown(name, content) : { ok: false }));
    ipcMain.handle('report:save-pdf', (event, name, html) => (main && event.sender === main.webContents ? saveReportPdf(name, html) : { ok: false }));
    ipcMain.handle('report:reveal', (event, file) => {
      if (main && event.sender === main.webContents && typeof file === 'string') shell.showItemInFolder(file);
    });
    ipcMain.on('claude:ask', (event, request) => {
      if (main && event.sender === main.webContents && request && typeof request.requestId === 'string') claudeAsk(event.sender, request);
    });
    ipcMain.on('claude:cancel', (_event, requestId) => claudeRuns.get(requestId)?.kill());
    ipcMain.on('claude:remember', (event, lines) => {
      if (!main || event.sender !== main.webContents) return;
      const clean = cleanLines(lines, 10);
      if (clean.length) appendNotes('gedaechtnis.md', MEMORY_HEADER, clean.map((line) => `- ${line}`), 0);
    });
    ipcMain.on('claude:log', (event, lines) => {
      if (!main || event.sender !== main.webContents) return;
      const clean = cleanLines(lines, 50).map((line) => (line.startsWith('- ') ? line : `- ${line}`));
      if (clean.length) appendNotes('claude-protokoll.md', LOG_HEADER, clean, 500);
    });
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
      if (Date.now() - reminderActionAt < REMINDER_ACTION_QUIET_MS) return;
      if (!main) createMain();
      else if (!main.isVisible()) { main.show(); activateShownAt = Date.now(); }
    });
  });

  // The shortcut has to keep working with the main window closed.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
