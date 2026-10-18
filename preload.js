// Runs before the page, with access to Electron; the page only gets what is
// handed over below.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enhancedDesktop', {
  hideQuickAdd: () => ipcRenderer.send('quickadd:hide'),
  // Die kommenden Mitteilungen zu fälligen Aufgaben (siehe main.js).
  setReminders: (list) => ipcRenderer.send('desktop:reminders', list),
  // Der macOS-Kalender (siehe main.js): access, calendars, events, create, update, delete, create-calendar.
  calendar: (command, input) => ipcRenderer.invoke('calendar', command, input),
  // E-Mails als Aufgaben (siehe main.js): Apple Mail per AppleScript, die Drag-Ablage, .eml-Dateien.
  mail: {
    fromAppleMail: (messageId) => ipcRenderer.invoke('mail:apple', messageId),
    dragPasteboard: () => ipcRenderer.invoke('mail:drag'),
    readEml: (file) => ipcRenderer.invoke('mail:read-eml', file),
  },
  // Report exportieren (siehe main.js): Sichern-Dialog, dann Datei schreiben.
  report: {
    saveMarkdown: (name, content) => ipcRenderer.invoke('report:save-md', name, content),
    savePdf: (name, html) => ipcRenderer.invoke('report:save-pdf', name, html),
    reveal: (file) => ipcRenderer.invoke('report:reveal', file),
  },
  // Claude über die installierte CLI (siehe main.js). Ereignisse: delta, done, error, cancelled.
  claude: {
    available: () => ipcRenderer.invoke('claude:available'),
    ask: (request) => ipcRenderer.send('claude:ask', request),
    cancel: (requestId) => ipcRenderer.send('claude:cancel', requestId),
    // Gedächtnis-Einträge, die der Nutzer bestätigt hat, und das Protokoll seiner Entscheidungen.
    remember: (lines) => ipcRenderer.send('claude:remember', lines),
    log: (lines) => ipcRenderer.send('claude:log', lines),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('claude:event', handler);
      return () => ipcRenderer.removeListener('claude:event', handler);
    },
  },
});

// Ein Klick auf eine Mitteilung: die Seite öffnet die Aufgabe.
ipcRenderer.on('desktop:open-task', (_event, itemId) => {
  window.dispatchEvent(new CustomEvent('enhanced:open-task', { detail: itemId }));
});

// Ein Knopf an einer Mitteilung (Erledigt, +15 Min., +1 Std.): die Seite führt ihn aus.
ipcRenderer.on('desktop:task-action', (_event, detail) => {
  window.dispatchEvent(new CustomEvent('enhanced:task-action', { detail }));
});

// The quick-add window is kept alive and shown again on each shortcut press.
ipcRenderer.on('quickadd:show', () => {
  window.dispatchEvent(new CustomEvent('enhanced:quickadd'));
});

/* Systemeinstellungen als Klassen auf <html>: desktop-vibrant (das Fenster
   trägt das macOS-Material), reduce-transparency, more-contrast. Das
   Stylesheet der Seite richtet sich danach. */
function applyEnv(env) {
  const classes = document.documentElement.classList;
  classes.toggle('desktop-vibrant', Boolean(env.vibrant));
  classes.toggle('reduce-transparency', Boolean(env.reduceTransparency));
  classes.toggle('more-contrast', Boolean(env.moreContrast));
}
ipcRenderer.on('desktop:env', (_event, env) => applyEnv(env));

/* Welches Design die Seite gerade zeigt (data-theme auf <html>), damit die
   Hülle Fenstermaterial und Startfarbe anpasst. Nur das Hauptfenster meldet. */
function reportScheme() {
  const scheme = document.documentElement.dataset.theme;
  if (scheme) ipcRenderer.send('desktop:scheme', scheme);
}

/* Fenster verschieben: Maus gedrückt im Kopf → main.js bewegt das Fenster mit,
   bis die Maus losgelassen wird. Kopf = leerer Hintergrund in den obersten
   44 px, die Profilzeile der Seitenleiste und die Titelzeile der Seite;
   Bedienelemente darin bleiben normal klickbar. */
const DRAG_BAND = 44;
const DRAG_ZONES = '.sidebar .side-top, .page .phead';
const BACKGROUND = 'html, body, .app, .workspace, .sidebar, .screen, .page';
const NOT_DRAG = [
  '.menu', '[role=menu]', '[role=dialog]', '[role=listbox]',
  'button', 'a[href]', 'input', 'textarea', 'select', 'label', 'summary',
  '[role=button]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=switch]',
  '[role=option]', '[role=link]', '[contenteditable]:not([contenteditable=false])',
  '[draggable=true]',
].join(', ');
let draggingWindow = false;
function inDragArea(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || event.button !== 0 || target.closest(NOT_DRAG)) return false;
  if (target.closest(DRAG_ZONES)) return true;
  return event.clientY < DRAG_BAND && target.matches(BACKGROUND);
}
function endWindowDrag() {
  if (!draggingWindow) return;
  draggingWindow = false;
  ipcRenderer.send('window:drag-end');
}
function watchWindowDrag() {
  window.addEventListener('mousedown', (event) => {
    if (!inDragArea(event)) return;
    event.preventDefault(); // keine Textauswahl beim Ziehen
    if (event.detail === 2) { ipcRenderer.send('window:double-click'); return; }
    draggingWindow = true;
    ipcRenderer.send('window:drag-start');
  }, true);
  window.addEventListener('mouseup', endWindowDrag, true);
  window.addEventListener('blur', endWindowDrag);
}

// Lets the site's stylesheet make room for the window buttons.
window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  root.classList.add('desktop-app');
  applyEnv(ipcRenderer.sendSync('desktop:env'));
  if (new URLSearchParams(location.search).has('quickadd')) return;
  watchWindowDrag();
  reportScheme();
  new MutationObserver(reportScheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
});
