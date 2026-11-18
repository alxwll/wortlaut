# Wort. Laut. – Einrichtung

Drei Teile, jeweils einmalig: **Azure** (die Stimme), **Cloudflare Worker** (Schlüssel, Zugänge, Kontingente) und **GitHub Pages** (die App selbst). Dauer: ca. 20–30 Minuten.

---

## 1. Azure: Sprachdienst anlegen

1. Auf **portal.azure.com** anmelden (bzw. kostenloses Konto anlegen – Kreditkarte nötig, der Gratis-Tarif kostet nichts).
2. Oben suchen: **„Speech services“** → **Create**.
3. Ausfüllen:
   - **Resource group:** neu anlegen, z. B. `wortlaut`
   - **Region:** `West Europe`
   - **Name:** z. B. `wortlaut-stimme`
   - **Pricing tier:** **Free F0** (0,5 Mio. Zeichen/Monat ≈ 8 Stunden Hören)
4. **Review + create** → **Create**, kurz warten → **Go to resource**.
5. Links **Keys and Endpoint** öffnen: **KEY 1** kopieren und die **Location/Region** notieren (`westeurope`).

Den Schlüssel nirgends öffentlich ablegen – er kommt gleich nur in den Worker.

> Später mehr als 8 h/Monat? Tarif auf **S0** umstellen (ca. 15 $ pro 1 Mio. Zeichen, also grob 1 € pro Stunde Hören).

---

## 2. Cloudflare: Worker einrichten

Im Cloudflare-Dashboard (wie bei On. Track):

1. **Workers & Pages → Create → Create Worker**, Name: `wortlaut` → **Deploy**.
2. **Edit code** → den kompletten Inhalt von `worker/worker.js` (im Repository) einfügen → **Deploy**.
3. Speicher für Zugänge anlegen: **Storage & Databases → KV → Create namespace**, Name: `wortlaut-codes`.
4. Zurück zum Worker → **Settings → Bindings → Add → KV namespace**:
   - **Variable name:** `CODES` (genau so)
   - **KV namespace:** `wortlaut-codes`
5. **Settings → Variables and Secrets → Add** – dreimal, jeweils Typ **Secret**:
   - `AZURE_KEY` = KEY 1 aus Azure
   - `AZURE_REGION` = `westeurope`
   - `ADMIN_CODE` = dein persönlicher Zugangscode, z. B. ein langes Passwort. Damit hast du unbegrenzten Zugang und die Verwaltung der Zugänge.
6. **Deploy**. Die Adresse steht oben, z. B. `https://wortlaut.x-sall.workers.dev`. Wer sie im Browser öffnet, sieht `{"ok":true,"app":"wortlaut"}`.

---

## 3. GitHub Pages: App veröffentlichen

Der Code liegt schon im Repository `alxwll/wortlaut`.

1. In `config.js` die Worker-Adresse eintragen (oder Claude Bescheid geben):
   ```js
   window.HB_CONFIG = { workerUrl: 'https://wortlaut.x-sall.workers.dev' };
   ```
2. Im Repository **Settings → Pages → Source: Deploy from a branch → Branch: main / (root) → Save**. Nach 1–2 Minuten läuft die App unter `https://alxwll.github.io/wortlaut/`.

---

## 4. Auf dem Handy

1. Die App-Adresse in Chrome öffnen → Menü **⋮ → Zum Startbildschirm hinzufügen**.
2. **Einstellungen** (Zahnrad) → **Zugangscode** = dein `ADMIN_CODE` → speichern.
3. **Probehören** – fertig. EPUB über **+** laden.

## Andere einladen

**Einstellungen → Zugänge verwalten → Neue Person einladen**: Name und Stunden pro Monat eintragen → **Einladung erstellen**. Der Link geht direkt per WhatsApp & Co. raus; wer ihn öffnet, ist sofort drin. Dort siehst du auch den Verbrauch, kannst Stunden ändern, pausieren oder löschen. Am Monatsersten startet alles neu.

Wer viel hört, kann in den Einstellungen unter **Eigener Azure-Schlüssel** einen eigenen Schlüssel eintragen – dann läuft es über das eigene Azure-Konto und nicht über dein Kontingent.

---

## Gut zu wissen

- **Bücher bleiben auf dem Handy.** EPUBs, Fortschritt und letzter Satz liegen nur im Browser-Speicher des Geräts. Auf den Server geht nur der Text, der gerade vorgelesen wird.
- **Seitenzahlen:** Die meisten EPUBs haben keine echten Druckseiten. Trag beim Import die Seitenzahl der gedruckten Ausgabe ein (und auf welcher Seite der Text beginnt), dann stimmen die Angaben auf etwa ±1–2 Seiten. Für die genaue Stelle gibt es immer den Satz bzw. die Wortsuche.
- **Ohne Zugang** liest die App mit der eingebauten Handy-Stimme – gut zum Ausprobieren, aber nicht schön.
- **Cloudflare-Gratis-Tarif:** reicht für mehrere Stunden Hören pro Tag (KV erlaubt 1.000 Schreibvorgänge/Tag, ein Vorleseabschnitt ≈ 1 Schreibvorgang ≈ 40 Sekunden Audio).
- **Bildschirm aus:** Die Wiedergabe läuft im Hintergrund weiter und lässt sich über Sperrbildschirm und Kopfhörer steuern. Falls dein Handy die App im Hintergrund zu aggressiv schlafen legt: in den Android-Einstellungen für Chrome die Akku-Optimierung ausschalten.
