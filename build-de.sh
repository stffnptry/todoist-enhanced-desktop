#!/bin/zsh
# Baut die deutsche Ausgabe: Web-App (../web, Branch "deutsch")
# bauen, nach web/ kopieren, .app packen, ad-hoc signieren, .dmg erzeugen.
set -e
cd "${0:A:h}"
WEB=../web
# Abhängigkeiten der Hülle passend zur package-lock.json, z. B. nach einem
# Electron-Update. Ohne Installationsskripte (die sind am Mac blockiert; ab
# Electron 42 braucht es keine mehr, electron-builder lädt Electron selbst).
want=$(node -p "require('./package-lock.json').packages['node_modules/electron'].version")
have=$(node -p "try { require('./node_modules/electron/package.json').version } catch { '' }")
if [[ "$want" != "$have" || ! -f node_modules/node-api-headers/include/node_api.h ]]; then
  echo "→ installiere Abhängigkeiten (Electron $want) …"
  npm ci --ignore-scripts --no-audit --no-fund
fi
(cd $WEB && npm run build)
rm -rf web && cp -R $WEB/dist web && rm -f web/og-image.png
# Kalender-Hilfsprogramm (EventKit)
mkdir -p build/native
swiftc -O native/calhelper.swift -o build/native/calhelper -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/calhelper-Info.plist
# Datei-Versprechen beim Ziehen (Mails aus Outlook), ein kleines Node-Modul
clang++ -std=c++17 -ObjC++ -fobjc-arc -bundle -undefined dynamic_lookup -arch arm64 -mmacosx-version-min=12.0 \
  -I node_modules/node-api-headers/include -framework AppKit native/dragpromise.mm -o build/native/dragpromise.node
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64
# Außerhalb von ~/Documents signieren: iCloud hängt dort Dateiattribute an,
# die codesign ablehnt.
TMP=$(mktemp -d)
ditto --norsrc --noextattr --noacl "dist/mac-arm64/Enhanced for Todoist DE.app" "$TMP/Enhanced for Todoist DE.app"
codesign --force -s - "$TMP/Enhanced for Todoist DE.app/Contents/Resources/calhelper"
codesign --force -s - "$TMP/Enhanced for Todoist DE.app/Contents/Resources/dragpromise.node"
codesign --force --deep -s - "$TMP/Enhanced for Todoist DE.app"
# (N): kein Fehler, wenn es noch keine .dmg gibt (frischer Clone) – zsh bricht sonst ab.
rm -f dist/*.dmg*(N)
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --prepackaged "$TMP/Enhanced for Todoist DE.app"
echo "Fertig: dist/Enhanced-for-Todoist-DE-arm64.dmg"
