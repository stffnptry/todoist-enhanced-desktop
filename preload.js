// Runs before the page, with access to Electron; the page only gets what is
// handed over below.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enhancedDesktop', {
  hideQuickAdd: () => ipcRenderer.send('quickadd:hide'),
  // Die kommenden Mitteilungen zu fälligen Aufgaben (siehe main.js).
  setReminders: (list) => ipcRenderer.send('desktop:reminders', list),
  // Der macOS-Kalender (siehe main.js): access, calendars, events, create, update, delete, create-calendar.
  calendar: (command, input) => ipcRenderer.invoke('calendar', command, input),
  // Claude über die installierte CLI (siehe main.js). Ereignisse: delta, done, error, cancelled.
  claude: {
    available: () => ipcRenderer.invoke('claude:available'),
    ask: (request) => ipcRenderer.send('claude:ask', request),
    cancel: (requestId) => ipcRenderer.send('claude:cancel', requestId),
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

// Lets the site's stylesheet make room for the window buttons.
window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  root.classList.add('desktop-app');
  applyEnv(ipcRenderer.sendSync('desktop:env'));
  if (new URLSearchParams(location.search).has('quickadd')) return;
  reportScheme();
  new MutationObserver(reportScheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
});
