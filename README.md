# Wort. Laut.

Eigene EPUBs mit natürlicher Stimme vorlesen lassen – mit Sonnenuntergangs-Sleep-Timer, Seitenzahl und letztem Satz zum Weiterlesen im Buch.

- App: statische Web-App (dieses Verzeichnis), läuft über GitHub Pages
- `worker/worker.js`: Cloudflare Worker für die Azure-Stimme, Zugangscodes und Kontingente
- Einrichtung: siehe [ANLEITUNG.md](ANLEITUNG.md)

Bücher und Lesefortschritt bleiben auf dem jeweiligen Gerät. Schlüssel gehören nie in dieses Repository – nur als Secrets in den Cloudflare Worker.
