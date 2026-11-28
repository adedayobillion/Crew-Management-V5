# Express Crews mobile (Android and iOS)

Capacitor shells that open the live site (`server.url` in `capacitor.config.json`) in a native webview with the Express Crews icon, splash screen and status bar. The web app stays the single source of truth: deploy to Railway and both apps update with no store release.

- Change the address: edit `server.url` and `allowNavigation`, then `npx cap sync`.
- Android: CI builds a debug APK (artifact `express-crews-android-debug-apk`). For the Play Store you need a signed release AAB (upload key + Play Console account).
- iOS: needs a Mac with Xcode and an Apple Developer account. Open with `npx cap open ios`, set the team under Signing, archive and upload.
- Icons and splash come from `assets/` (`npx capacitor-assets generate`).
- Bundle id: `com.expresscrews.app`.

Apple can reject apps that are only a website in a frame (guideline 4.2). Add native features before submitting, push notifications for new bookings and messages being the obvious first one.
