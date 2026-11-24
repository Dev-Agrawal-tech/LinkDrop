# LinkDrop

LinkDrop has the two app folders requested:

- `extension/` — Chrome laptop extension frontend and its service URL/API connector.
- `mobile-application/` — responsive phone PWA, Android Studio wrapper, shared backend API, relay, and SQLite database.

Both apps use the same backend service in `mobile-application/backend`. Keeping one relay is what lets the extension and phone find the same pairing code and pass data between them.

## Run a local demo

Install Node.js 24 or newer. Open a terminal in `mobile-application/backend`, copy `.env.example` to `.env`, then install the QR dependency and run the service:

```sh
npm install
npm start
```

Open <http://localhost:3000> on the laptop and choose **This is my laptop** to view the QR and phone URL. Scan it from a phone on the same Wi-Fi. Create a code on the phone; enter it in the Chrome extension.

To install the extension, open `chrome://extensions`, turn on Developer mode, select **Load unpacked**, and choose the `extension` folder.

## Start the backend automatically on Windows

If you do not want to run `npm start` every time, install the LinkDrop background service once:

1. Open the `mobile-application` folder.
2. Open PowerShell (Run as Administrator) in the `mobile-application` folder.
3. Run:

   ```powershell
   & ".\install-background-service.ps1"
   ```

The backend will then start automatically in the background whenever you sign in to Windows.

<!-- ************************************************************************** -->

## API and production requirements

The app has its own API; no third-party messaging or file-transfer API key is required. The API routes are `GET /api/health` and `POST /api/activity` (JSON body: `{"code":"123456"}`). Pairing and transfer negotiation use the WebSocket route `/relay`.

The SQLite database records pairing-session status and activity metadata only. It stores no file bytes, note text or raw pairing code. Each browser also keeps its own small local history so previously shared notes/file names can reappear after a restart. Already-saved files remain on the receiving device. Activity metadata expires after 30 days. Pairing stays active for 24 hours and then requires a new code. Temporary network/app disconnections preserve the pairing; **Disconnect** ends it deliberately. There is no application-level total transfer quota; storage, network, browser and host capacity still apply. To reach devices outside one Wi-Fi network, deploy the shared backend at a public HTTPS address with WebSocket forwarding enabled. Set that address in the extension popup and in `mobile-application/android/app/src/main/res/values/strings.xml`.

The relay temporarily handles message and file data while forwarding it. Files and note text are not written to its database, but this version does not use end-to-end encryption, so the server operator could technically read data while it passes through the relay. Use a trusted host and HTTPS/WSS; add end-to-end encryption before promising that the server operator cannot read shared content.

For production, use a persistent disk for SQLite or replace SQLite with a managed database such as PostgreSQL. Use HTTPS/WSS, set `TRUST_PROXY=1` only behind a proxy that overwrites the forwarded client address, and add rate limits appropriate to the host. If choosing Supabase/Postgres, the backend will need the project URL and a server-only secret; never put a service key in the extension or Android app. That cloud setup is optional for the current local demo.

The Dockerfile can be built from the mobile folder with `docker build -t linkdrop -f mobile-application/Dockerfile mobile-application`; mount a persistent volume at `/app/backend/data` if the container will keep the SQLite file. On Windows, run `mobile-application/install-background-service.ps1` once to add a hidden LinkDrop launcher to the signed-in user's Startup folder.

The Android project targets API 36. Publishing still requires a public service address, final package name and store artwork, a signed Android App Bundle, and a Play Console listing/review. The project has not been signed or published.

See [extension setup](extension/README.md) and [mobile app, backend and database setup](mobile-application/README.md).
