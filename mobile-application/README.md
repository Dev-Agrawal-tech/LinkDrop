# LinkDrop mobile app and shared service

## Folders

- `frontend/pwa/` — responsive app interface and installable PWA shell.
- `android/` — Android Studio WebView app with native document pickers for opening and saving files.
- `backend/` — shared HTTP API, WebSocket relay, environment template, and SQLite database.

## Run locally

Use Node.js 24 or newer. In a terminal opened in `backend/`, copy `.env.example` to `.env`, run `npm install`, then run `npm start`. The app is served at `http://localhost:3000`.

On a physical phone, use the laptop's LAN address while both devices are on the same Wi-Fi. Change `android/app/src/main/res/values/strings.xml` to that address to run the Android wrapper on a physical phone. For the Android emulator, `http://10.0.2.2:3000` points to the development computer.

To avoid opening a terminal every time, run `install-background-service.ps1` once from PowerShell. It adds a hidden LinkDrop launcher to the signed-in user's Windows Startup folder, so the backend starts after each Windows sign-in. The browser/PWA and extension still need to be open for the visible connection; they automatically retry the saved pairing while it is within the 24-hour window. A temporary network or app disconnect no longer ends the pairing. Use **Disconnect** to deliberately end it.

In the laptop browser, choose **This is my laptop** to see a QR code and local phone address. The QR is generated locally by the backend and contains a private Wi-Fi URL; it does not use an external QR service. Scan it while both devices are on the same Wi-Fi. If several network adapters are present, confirm the shown address is reachable from the phone.

For a deployed service, set `PUBLIC_URL` in `.env` to its public HTTPS origin (for example, `https://linkdrop.example.com`) so the QR opens the deployed portal. `PORT` can be changed if another local project already uses port 3000; the generated QR and local phone link use the configured port.

## Database and API

SQLite initializes itself from `backend/database/schema.sql`; its local file is created at `backend/data/linkdrop.sqlite`. It keeps hashed, expiring pairing records and activity metadata (event type, sender role, size and time), not notes or file contents. Records are cleaned up after 30 days. A pairing code and its connected session stay valid for 24 hours; after that, create and enter a fresh code. There is no application-level total transfer quota or default file-size cap. Real limits are storage, network speed, browser/Android save behavior and host capacity.

Each browser also keeps a small local activity history for the current pairing, so notes/file names can reappear after the backend restarts. The server database stores pairing hashes and transfer metadata, not file bytes or note contents. The relay still handles messages and file data while sending; this version does not provide end-to-end encryption, so do not treat it as confidential against the server operator. Already-saved files remain in the receiver's Downloads or chosen folder.

- `GET /api/health` — service/database status.
- `POST /api/activity` with `{"code":"123456"}` — recent metadata for an active pairing code.
- `WS /relay` — pairing and transfer relay.

See [API protocol details](backend/API.md). The database code and schema are under `backend/database/`. Set `DATABASE_PATH` to a persistent location for deployment. The included Dockerfile uses Node 24; mount durable storage at `/app/backend/data` if keeping SQLite in a container.

## Android publishing

Set `service_url` to your public HTTPS address, disable cleartext traffic in `android/app/src/main/AndroidManifest.xml`, set your final application ID, and create a signed Android App Bundle. The app source is prepared but has not been built, signed or submitted to Google Play.
