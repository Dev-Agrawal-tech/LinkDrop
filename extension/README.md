# LinkDrop Chrome extension

This folder is the laptop client. `frontend/` contains the popup UI, and `backend/app-api.js` builds a safe link into the shared mobile service. It does not run a second server or database; both clients must use the same relay backend.

1. Start the shared service from `mobile-application/backend`.
2. In Chrome, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `extension` folder.
4. Open the LinkDrop toolbar popup, enter the code shown on the phone, and connect.

The default service is `http://localhost:3000`. For an internet-hosted service, save its HTTPS address under **Sharing service address** in the popup.
