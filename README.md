# zynthec-altstore-source

Eine schlanke AltStore-/SideStore-Source für eigene IPA-Dateien mit browserbasierter Admin-Seite.

## Enthalten

- `https://zynthec.com/zloader`: öffentliche zLoader-Website mit aktueller IPA, Anleitung und Link zum App-Repository.
- `https://zynthec.com/zloader/source.json`: kompatibler AltSource-Feed.
- `https://zynthec.com/zloader/admin/`: Apps hochladen, entfernen und ihre Metadaten gestalten.
- Automatische Metadaten- und Icon-Erkennung für im Katalog ausgewählte IPA-Dateien.
- GitHub Releases mit eigenem Tag und Änderungstext für jede neue IPA-Version.

Die Website verlinkt die jeweils veröffentlichte zLoader-IPA. Der erste Download muss mit einem Sideloading-Tool signiert und installiert werden; es gibt keine Profil-basierte Direktinstallation und keine Zusammenführung fremder Sources.

## Lokal bauen

```bash
python3 scripts/release_pipeline.py download
python3 scripts/build.py
python3 -m unittest discover -s tests -v
# Mit Cloudflare-Routing unter /zloader:
npx wrangler pages dev dist
```

Der fertige statische Build liegt in `dist/`.

## Erste IPA

`miPet-0.3-beta.ipa` enthält laut eingebetteter `Info.plist` die Version **0.1.0 (Build 1)**. Diese echten Metadaten werden im Feed verwendet.

IPAs werden nicht in Git eingecheckt. Die vorhandene miPet-Version liegt noch im Release `apps`:

```bash
gh release create apps --title "App downloads" --notes "Binary releases used by zynthec-altstore-source."
gh release upload apps miPet-0.3-beta.ipa
```

Neue Versionen erhalten beim Upload aus `/admin/` automatisch einen eigenen Release-Tag und den Text aus „Neu in dieser Version“ als Release Notes. Die Admin-Seite lädt Dateien bis 70 MB über GitHubs Git-Blob-API zwischen; GitHub Actions prüft die IPA, erstellt das Release und aktualisiert den Feed. Die Datei wird nicht in die Git-Historie eingecheckt. Für größere Dateien kann der Workflow **Publish IPA** eine direkte HTTPS-Datei-URL übernehmen und ebenfalls ein neues Release mit Änderungstext erstellen.

## Admin-Zugang

Der Zugang zu `/zloader/admin/` erfolgt ausschließlich mit einem Passwort. Über **Passwort ändern** im Panel kannst du es nach Eingabe des aktuellen Passworts ändern. Alle anderen Sitzungen werden dabei ungültig. Es gibt weder Token-Felder noch eine GitHub-Verbindungseinrichtung im Browser.

Das initiale oder temporäre Passwort wird serverseitig als gesalzener PBKDF2-Hash in D1 eingerichtet. Nach der Anmeldung kann es sofort im Panel ersetzt werden. Ohne serverseitige Repository-Verbindung sind Katalogansicht und Passwortwechsel möglich; Änderungen an Apps/Source sowie Uploads bleiben gesperrt.

Für Speichern und Uploads benötigt ausschließlich der Server einen GitHub-Zugang. Ein Cloudflare-Administrator hinterlegt ihn als verschlüsseltes Secret **`GITHUB_TOKEN`** im Pages-Projekt. Ein Fine-grained Token sollte auf `zynthec-dev/zynthec-altstore-source` beschränkt sein mit:

- Repository permission `Contents: Read and write`
- möglichst kurzer Laufzeit

Der Server unterstützt außerdem bereits vorhandene, mit AES-GCM verschlüsselte Tokens in D1; der separate Schlüssel `ADMIN_ENCRYPTION_KEY` liegt als Cloudflare-Secret vor. Es existiert kein öffentlicher Endpunkt zur Einrichtung oder Übertragung eines Tokens. Passwörter werden ausschließlich als gesalzener PBKDF2-SHA-256-Hash gespeichert. Der Browser erhält eine Secure/HttpOnly/SameSite-Strict-Sitzung mit acht Stunden Laufzeit, nicht den GitHub-Token. Abmelden widerruft die Sitzung serverseitig. Anmeldeversuche sind pro IP und global begrenzt; schreibende Anfragen benötigen einen passenden Origin und einen eigenen Header. GitHub-Anfragen werden nur an die für die App-Verwaltung zugelassenen Endpunkte dieses Repositorys weitergeleitet.

Die Browser-IPA wird als zunächst unreferenzierter Git-Blob bei GitHub abgelegt; GitHub Actions überführt sie ins Release. Bei abgelaufenem GitHub-Token ist eine serverseitige Erneuerung erforderlich; ein Passwortwechsel verlängert dessen Laufzeit nicht.

Für ein neues Deployment: D1-Binding `ADMIN_DB` aus `wrangler.jsonc` einrichten, `migrations/0001_admin.sql` anwenden und `ADMIN_ENCRYPTION_KEY` als zufälliges 32-Byte-Hex-Secret setzen. Ohne Binding oder Secret bleibt der Admin-Zugang gesperrt; der öffentliche Feed ist weiterhin lesbar. Für lokale Entwicklung isolierte D1-Daten und eigene `.dev.vars`-Secrets verwenden, niemals Produktionsdaten. Nach Verlust des Passworts kann der Cloudflare-Administrator den Passwort-Hash mit neuem Salt aktualisieren, die Revision erhöhen und Sitzungen widerrufen; App-Katalog und Repository-Verbindung bleiben unberührt. Den Verschlüsselungsschlüssel nicht einfach rotieren: Bereits gespeicherte D1-Tokens müssen dabei neu verschlüsselt oder neu eingerichtet werden.

Die App-Verwaltung ermöglicht:

- IPA-Dateien hochzuladen und bei jeder neuen Version ein eigenes GitHub Release mit Änderungstext zu erstellen,
- Namen, Versionstexte, Beschreibungen und Farben zu ändern,
- eigene Icons und Screenshot-URLs zu hinterlegen.

Über **Source-Einstellungen** lassen sich Anzeigename, Kurzbeschreibung, Beschreibung, Akzentfarbe und das Source-Icon (PNG, maximal 2 MB) ändern. Einstellungen und Icon werden gemeinsam in einem Commit gespeichert und anschließend automatisch durch Cloudflare veröffentlicht. Die Source-URL, Kennung und Repository-Verbindung bleiben erhalten. Bei zwischenzeitlichen Änderungen wird das Speichern abgebrochen, damit keine fremden Änderungen überschrieben werden.

## Deployment

Cloudflare Pages ist direkt mit `zynthec-dev/zynthec-altstore-source` verbunden. Jeder Push auf `main` baut und testet die Source und veröffentlicht den erfolgreichen Build. Der Download öffentlicher IPA-Releases funktioniert ohne GitHub-Token oder GitHub CLI im Cloudflare-Build.

GitHub Actions veröffentlicht vorgemerkte IPAs als versionierte Releases und committet den fertigen Katalog. Dieser Commit löst den nächsten Cloudflare-Build aus. Solange eine IPA noch nicht als Release verfügbar ist, schlägt der Build fehl; der letzte erfolgreiche Stand bleibt online. Nach erfolgreicher Veröffentlichung wird der aktualisierte Katalog automatisch gebaut.

Der Pages Worker in `site/_worker.js` liefert die Website unter `/zloader`, den Feed unter `/zloader/source.json` mit JSON-Content-Type und CORS sowie Icons unter `/zloader/assets/*`. `/zloader/admin/api/*` übernimmt Anmeldung und geschützte GitHub-Zugriffe. `/zloader/admin` wird für relative Assets auf `/zloader/admin/` umgeleitet. Interne Worker-Module und andere Webpfade bleiben unzugänglich. GitHub Pages wird nicht mehr zum Deployment verwendet. Der Download-Button wird bei jedem Build aus dem neuesten zLoader-Eintrag des Katalogs erzeugt.

- Cloudflare account: `7624241f771550ac62dd106ba6b0b749`
- Pages project: `zynthec-altstore-source`
- Repository: `zynthec-dev/zynthec-altstore-source`
- Production branch: `main`
- Build command: `python3 scripts/cloudflare_build.py`
- Output directory: `dist`
- Custom domain: `zynthec.com`
- Website: `https://zynthec.com/zloader`
- Source: `https://zynthec.com/zloader/source.json`
- Admin: `https://zynthec.com/zloader/admin`
- `altsource.zynthec.com` und `source.zynthec.com` sind nicht mehr zugeordnet. `zloader.zynthec.com` leitet vorübergehend auf die neue Source und ihre Assets um, weil zLoader 0.7.50 diese Adresse noch eingebettet hat; die Zuordnung kann nach einem App-Update entfernt werden. Die technische Pages-Domain bleibt als Deployment-Ursprung erhalten.
- Die Source-ID `com.zynthec.source` bleibt für bereits hinzugefügte Sources stabil.


## Gestaltung


Das Admin-Panel unterstützt System/Hell/Dunkel, speichert ausschließlich die Darstellungspräferenz in localStorage und bleibt per Tastatur bedienbar. Dezente CSS-Transparenz ist eine Webannäherung; Apples native Liquid-Glass-Materialien werden nur im iOS-Icon verwendet. Reduzierte Bewegung, erhöhter Kontrast und reduzierte Transparenz werden berücksichtigt, soweit der Browser die entsprechenden Medienabfragen unterstützt.

Der isolierte Browsertest `tests/admin-ui.mjs` benötigt Playwright und Chrome. Mit `ADMIN_TEST_URL` lässt sich eine lokale Preview auswählen; `ADMIN_TEST_ROOT` kann alternativ die generierten `dist`-Dateien direkt bereitstellen. `PLAYWRIGHT_MODULE`, `CHROME_PATH` und `ADMIN_SCREENSHOTS` sind optional konfigurierbar. Der Test fängt sämtliche Backend-Anfragen ab und verwendet ausschließlich Testdaten. Er prüft Passwortanmeldung und -wechsel, Reihenfolge, Tastaturbedienung, Abbrechen ohne Schreibzugriff, Theme-Persistenz, mobile Breite und Reduce Motion. `node tests/admin-auth.mjs` prüft die serverseitige Authentifizierung mit echter isolierter SQLite-Datenbank und benötigt Python 3, aber keine zusätzlichen Pakete.

Der Website-Test `tests/landing-ui.mjs` prüft Download-/GitHub-/Source-Links, Kopieren mit Berechtigungs-Fallback, echte Icons und responsive Layouts. `LANDING_TEST_ROOT` bedient isoliert den Build über den echten Worker; ohne diese Option prüft `LANDING_TEST_URL` (standardmäßig die Live-Website) rein lesend. `LANDING_SCREENSHOTS` wählt den Screenshot-Ordner.

Apps werden mit angehefteten Einträgen zuerst, ansonsten alphabetisch aufgeführt. Alte IPA-Dateien im lokalen Projektordner oder in historischen Releases erscheinen nicht erneut, solange sie nicht im Katalog ausgewählt sind.
