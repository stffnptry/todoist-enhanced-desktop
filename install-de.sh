#!/bin/zsh
# Installiert die zuletzt gebaute deutsche Ausgabe (dist/*.dmg) nach /Applications:
# App beenden, .dmg einbinden, App ersetzen, .dmg auswerfen, App starten.
# Mit --build wird vorher neu gebaut (build-de.sh).
set -e
cd "${0:A:h}"

APP_NAME="Enhanced for Todoist DE"
DMG=dist/Enhanced-for-Todoist-DE-arm64.dmg

if [[ "$1" == "--build" ]]; then
  ./build-de.sh
fi
[[ -f "$DMG" ]] || { echo "Keine .dmg gefunden ($DMG). Erst bauen: ./build-de.sh"; exit 1; }

echo "→ Beende $APP_NAME …"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
# Warten, bis sie wirklich zu ist (höchstens 10 s).
for _ in {1..20}; do
  pgrep -xq "$APP_NAME" || break
  sleep 0.5
done
# Hängt sie noch, wird sie hart beendet (samt ihrer Hilfsprozesse).
if pgrep -xq "$APP_NAME"; then
  echo "  … reagiert nicht, beende hart"
  pkill -x "$APP_NAME" || true
  pkill -f "/Applications/$APP_NAME.app/" || true
  sleep 1
fi

echo "→ Binde die .dmg ein …"
MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" | tail -1 | awk -F'\t' '{print $NF}')
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true' EXIT

echo "→ Ersetze /Applications/$APP_NAME.app …"
rm -rf "/Applications/$APP_NAME.app"
ditto "$MOUNT/$APP_NAME.app" "/Applications/$APP_NAME.app"
xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app" 2>/dev/null || true

echo "→ Starte $APP_NAME …"
open -a "/Applications/$APP_NAME.app"
echo "Fertig."
