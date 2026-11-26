# OpenWorks

OpenWorks ist eine selbst gehostete Softwareverteilung für Windows. Administratoren erstellen Bundles im Browser und weisen deren Aktionslisten Geräten oder Benutzern zu. Ein Rust-Agent ruft die passenden Regeln ab, führt sie auf dem Ziel aus und meldet das Ergebnis an die Webkonsole.

## Funktionsumfang

| Bereich | Verhalten in Version 0.1 |
| --- | --- |
| Install | Geordnete Liste von MSI-Paketen aus dem Serverkatalog. Der Agent prüft jede Datei vor der Verwendung per SHA-256. |
| Start | Geordnete Liste installierter EXE-Dateien unter `Program Files`. Der Benutzer-Agent arbeitet bei Bedarf zuerst die Install-Liste ab und startet die Anwendungen in der interaktiven Sitzung. |
| Uninstall | Geordnete Liste von MSI-Paketen, die Windows Installer deinstalliert. |
| Zuweisung | Ein Bundle, eine Aktionsliste, eine Zielkennung und ein Auslöser pro Regel. Benutzer können dieselbe Zielkennung auf mehreren Geräten verwenden. |
| Auslöser | Beim nächsten Abruf, zu einem einmaligen Zeitpunkt, beim Systemstart oder bei der Anmeldung. Beim Booten sind Geräteziele verfügbar. |
| Variablen | Globale Werte und Bundle-Werte mit der Schreibweise `${NAME}`. Bundle-Werte haben Vorrang. Platzhalter sind in MSI-Namen und EXE-Pfaden verfügbar. |
| Rückmeldung | Die Konsole zeigt den letzten Abruf sowie Erfolg, Neustartbedarf oder Fehler je Agent und Zuweisung. |

## Server unter Windows starten

Benötigt werden Python ab 3.10 und PowerShell. Die Befehle im Projektverzeichnis ausführen.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m server.app init
.\.venv\Scripts\python.exe -m server.app serve
```

`init` fragt ein Admin-Passwort ab. Die lokale Konsole läuft unter [localhost:8787](http://localhost:8787). Für verwaltete Rechner einen HTTPS-Reverse-Proxy auf dem Windows Server vor `127.0.0.1:8787` schalten und den Server mit `serve --secure-cookie` starten. Die Clients müssen dem Serverzertifikat vertrauen. Der Upload unterstützt bis zu 512 MiB pro MSI. Das Uploadlimit am Proxy entsprechend setzen.

SQLite-Datenbank und Paketinhalte liegen unter `instance/`. Mit `--data PFAD` bei beiden Befehlen ein anderes Datenverzeichnis wählen. Zum Sichern den Server beenden und das komplette Verzeichnis kopieren. Für einen Passwortwechsel den Server stoppen, erneut `init` ausführen und den Server starten. Dadurch verfallen bestehende Admin-Sitzungen.

## Server mit Docker Compose

```sh
docker compose up -d --build --wait
docker compose exec server python -m server.app init --data /data
docker compose restart server
```

Der Container speichert Datenbank und MSI-Dateien im benannten Volume `data`. Docker bindet Port 8787 an die Loopback-Adresse des Hosts. Für den Zugriff im Tailnet stellt Tailscale Serve das HTTPS-Zertifikat und den Proxy bereit. Den gewünschten HTTPS-Port vorher mit `tailscale serve status` prüfen.

```sh
tailscale serve --bg --https=8787 http://127.0.0.1:8787
docker compose ps
```

Die von Tailscale ausgegebene HTTPS-Adresse dient der Webkonsole und dem Agenten als Serveradresse. Der Agent baut die Verbindung vom Windows-Gerät zum Server auf.

## Einen Windows-Agenten einrichten

1. In der Konsole **Geräte → Agent registrieren** oder **Benutzer → Agent registrieren** wählen. Für ein Gerät beispielsweise Zielkennung `PC-023`, für einen Benutzer `FIRMA\anna` verwenden. Jede Installation erhält ein eigenes Token. Die Zielkennung wird administrativ beim Registrieren festgelegt. Es gibt in dieser Version keinen Verzeichnisdienstabgleich.
2. Das einmalig angezeigte Token bereithalten. Der Agent liegt als Rust-Quellprojekt bei. Auf einem Windows-Buildrechner mit Rust ab 1.89, C++-Build-Tools und Windows SDK für die Zielarchitektur bauen.

   ```powershell
   ./scripts/Build-Client.ps1
   ```

   Für MSVC eine Visual-Studio-Entwicklershell mit verfügbarem Linker verwenden. Mit eingerichteter x64-GNU-Toolchain und MinGW-w64 funktioniert alternativ `./scripts/Build-Client.ps1 -Toolchain stable-x86_64-pc-windows-gnu`.

3. Beide EXE-Dateien aus `agent\target\release\` und `scripts\Install-Agent.ps1` auf den Zielrechner kopieren. Für die Geräteeinrichtung eine administrative PowerShell verwenden.

   ```powershell
   .\Install-Agent.ps1 -Scope device -Server https://openworks.example.org -Binary .\openworks-agent.exe
   ```

   Für die Benutzereinrichtung den Befehl mit `-Scope user` in der Sitzung des zugewiesenen Windows-Benutzers ausführen. Das Skript fragt das Token verdeckt ab. Auf demselben PC können beide Agenten parallel arbeiten.

4. Der Geräte-Agent läuft als SYSTEM, der Benutzer-Agent mit eingeschränkten Benutzerrechten. Windows-Aufgaben lösen Boot, Anmeldung und einen Abruf alle fünf Minuten aus. Ein Benutzer-MSI muss die Installation ohne erhöhte Rechte unterstützen. Bei mehreren Benutzerinstallationen mit gleicher Zielkennung erhält jede Installation die Zuweisungen.

## Anwendungskatalog und Objektseiten

Benutzer öffnen **OpenWorks Anwendungen** im Windows-Startmenü. Der lokale Windows-Forms-Katalog zeigt zugewiesene Apps als Kacheln oder Liste mit Suche und Favoriten. Vorhandene Anwendungssymbole werden für Start-Aktionen aus der installierten EXE gelesen. Alternative Symbole und Beschreibungen lassen sich in den Bundle-Einstellungen pflegen. Der Rust-Agent prüft eine manuelle Startzuweisung beim Klick erneut auf dem Server. Dafür die Startliste einem Benutzer mit Auslöser **Im Anwendungskatalog** zuweisen. Andere Auslöser behalten ihren Zeitplan.

Unter **Richtlinien → Anwendungskatalog → Einstellungen** lassen sich Fenstertitel, Hintergrund, Akzentfarbe, Standardansicht, Suche und Favoriten veröffentlichen. Die Richtlinie gilt für alle Benutzer-Agenten. Ein geöffnetes Fenster ruft sie alle fünf Minuten sowie über **Aktualisieren** ab. Eine deaktivierte Richtlinie verwendet die OpenWorks-Standardgestaltung.

Ein Klick auf einen Gerätenamen öffnet Zusammenfassung, Inventar, Zuweisungen, Einstellungen und Meldungen. Der Geräte-Agent sendet etwa alle 15 Minuten Windows- und Hardwareinformationen. Organisation und Standort können Administratoren ergänzen. Unter **Einstellungen** lassen sich die auf diesem Gerät installierten Benutzer-Agenten verknüpfen. Deren Katalog zeigt auch Gerätezuweisungen an, die weiterhin im Gerätekontext ausgeführt werden.

Ein Klick auf einen Bundle-Namen öffnet die Zusammenfassung. Weitere Reiter zeigen Beziehungen, Aktionslisten, Variablen, Freigabe und veröffentlichte Revisionen. Der Versionswähler schaltet zwischen Veröffentlichung und vorhandenem Sandbox-Entwurf um. Die Revisionsliste wird ab Installation dieser Version geführt. Für ältere Einträge sind historische Zeitpunkte unbekannt.

Bestehende Installationen mit **Install-Agent.ps1 -Update -Scope user -Binary .\openworks-agent.exe** aktualisieren. Die Katalog-EXE muss neben dem Rust-Agenten liegen. Für den Geräte-Agenten **-Scope device** administrativ ausführen. Das Update übernimmt die vorhandene Registrierung und die Windows-Aufgaben.

## Erstes Bundle verteilen

1. Unter **MSI-Pakete** ein Paket hochladen, etwa `Werkzeug-1.0.msi`.
2. Unter **Variablen** die globale Variable `PAKET` auf diesen Dateinamen setzen.
3. **Bundles → Bundle anlegen** öffnen. In der Install-Liste eine Aktion `${PAKET}` anlegen. In der Start-Liste beispielsweise `Hersteller\Werkzeug.exe` und in der Uninstall-Liste `${PAKET}` eintragen. Die Reihenfolge lässt sich über die Pfeiltasten im Editor ändern.
4. Unter **Zuweisungen** Bundle, Ziel, Aktionsliste und Auslöser wählen. Beispielsweise **Install → Gerät → Beim Booten** oder **Start → Benutzer → Bei Anmeldung**. Für ein benutzerspezifisches Paket den Variablenwert im Bundle überschreiben.
5. Unter **Geräte** oder **Benutzer** den letzten Abruf und unter **Ausführungen** das Ergebnis prüfen. Eine Programmstart-Rückmeldung bestätigt die erfolgreiche Prozesserstellung.

Zeitgesteuerte Regeln speichern einen absoluten Zeitpunkt. Offline-Geräte holen fällige Regeln beim nächsten Abruf nach. Eine Sofort- oder Zeitregel läuft einmal je Version und Agent. Eine Boot- oder Anmelderegel läuft bei jedem entsprechenden Ereignis. Gleichartige Ereignisse während einer Offlinephase werden zusammengefasst. Eine neue Bundle-Revision oder ein geänderter effektiver Aktionswert macht die Regel erneut ausführbar. Änderungen an ereignisgebundenen Regeln greifen beim passenden Ereignis.

Der Agent speichert abgeschlossene Schritte lokal und versucht fehlgeschlagene Schritte beim nächsten Abruf erneut. Ein Abbruch zwischen erfolgreicher Windows-Aktion und lokalem Speichern kann zur Wiederholung dieses Schritts führen. Eine erfolgreiche MSI-Installation mit ausstehendem Neustart wird gemeldet. Der Agent startet den Rechner dafür nicht selbst neu.

Zum Entfernen einer Anwendung eine Uninstall-Regel zuweisen und konkurrierende Install- oder Startregeln entfernen. Das Löschen einer Zuweisung beendet deren zukünftige Verteilung. Unter **Geräte** oder **Benutzer** lässt sich ein einzelnes Token widerrufen. Windows-Aufgaben heißen `OpenWorks-Device-*` oder `OpenWorks-User-<SID>-*`; Agent, Cache und Zustand liegen unter `%ProgramFiles%\OpenWorks\DeviceAgent` beziehungsweise `%LOCALAPPDATA%\OpenWorks\UserAgent`.

## Bundle-Katalog

Die Bundle-Ansicht bietet Ordner, Kategorien, Mehrfachauswahl und einen Suchbereich. Mit **Neu** legst du Windows-Bundles, Unterordner und Bundle-Gruppen an. Über den Ordnerpfad gelangst du zur übergeordneten Ebene. Die Option **Unterordner einbeziehen** durchsucht den gesamten gewählten Teilbaum. Favoriten gelten für den verwendeten Browser.

Unter **Aktion** kannst du ausgewählte Bundles verschieben, aktivieren oder deaktivieren. Deaktivieren blendet ihre Regeln beim nächsten Abruf aus. Bereits installierte Software bleibt auf dem Gerät. Nach erneuter Aktivierung können zuvor ausgeblendete Regeln wieder ausgeführt werden.

**Schnellaufgaben → Zuweisen** erstellt bei einer Gruppe Einzelzuweisungen für die zum Zeitpunkt der Bestätigung enthaltenen Bundles. Spätere Änderungen an der Gruppe wirken sich auf neue Gruppenzuweisungen aus. Fehlt die gewählte Aktionsliste oder besteht bereits eine entsprechende Zuweisung, bricht der Server den gesamten Vorgang ab.

Für eine vorbereitete Änderung an einem vorhandenen Bundle wähle **Schnellaufgaben → Sandbox bearbeiten**. Der Entwurf enthält die Aktionslisten und Bundle-Variablen. Der Agent erhält weiterhin die veröffentlichte Version. **Sandbox veröffentlichen** prüft die Aktionen und erhöht die Revision. Bei einer zwischenzeitlich geänderten Ausgangsversion schützt ein Versionsabgleich die neuere Bearbeitung.

## Projekt und Prüfung

- `server/` enthält die Flask-Webanwendung, den SQLite-Datenspeicher und die Webkonsole. Waitress bedient die HTTP-Anfragen.
- `agent/` enthält Abruf, Ausführungsplanung, Paketprüfung und Windows-Aktionen.
- `scripts/` enthält die Windows-Aufgabeneinrichtung.

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
cargo test --locked --manifest-path agent/Cargo.toml
```

Die erste Version konzentriert sich auf Windows, MSI-Verteilung und einen lokalen Admin-Zugang. Die fachliche Orientierung für die Aktionslisten ist die [ZENworks-Dokumentation zu Action Sets](https://docs.microfocus.com/doc/99/26.2/zen_cm_software_distribution_by5psy1).

OpenWorks steht unter der [MIT-Lizenz](LICENSE).
