#!/bin/zsh
# Baut die deutsche Ausgabe: Web-App (../todoist-enhanced-web, Branch "deutsch")
# bauen, nach web/ kopieren, .app packen, ad-hoc signieren, .dmg erzeugen.
set -e
cd "${0:A:h}"
WEB=../todoist-enhanced-web
(cd $WEB && npm run build)
rm -rf web && cp -R $WEB/dist web && rm -f web/og-image.png
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64
# Außerhalb von ~/Documents signieren: iCloud hängt dort Dateiattribute an,
# die codesign ablehnt.
TMP=$(mktemp -d)
ditto --norsrc --noextattr --noacl "dist/mac-arm64/Enhanced for Todoist DE.app" "$TMP/Enhanced for Todoist DE.app"
codesign --force --deep -s - "$TMP/Enhanced for Todoist DE.app"
rm -f dist/*.dmg*
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --prepackaged "$TMP/Enhanced for Todoist DE.app"
echo "Fertig: dist/Enhanced-for-Todoist-DE-arm64.dmg"
