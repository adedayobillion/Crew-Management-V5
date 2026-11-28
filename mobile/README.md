# Express Crews mobile (Android and iOS)

Capacitor shells that open the live site (`server.url` in `capacitor.config.json`) in a native webview with the Express Crews icon, splash screen and status bar. The web app stays the single source of truth: deploy to Railway and both apps update with no store release.

- Change the address: edit `server.url` and `allowNavigation`, then `npx cap sync`.
- Android: CI builds a debug APK (artifact `express-crews-android-debug-apk`). For the Play Store you need a signed release AAB (upload key + Play Console account).
- iOS: needs a Mac with Xcode and an Apple Developer account. Open with `npx cap open ios`, set the team under Signing, archive and upload.
- Icons and splash come from `assets/` (`npx capacitor-assets generate`).
- Bundle id: `com.expresscrews.app`.

Apple can reject apps that are only a website in a frame (guideline 4.2). Add native features before submitting, push notifications for new bookings and messages being the obvious first one.

## Play Store release (Android)
1. Make an upload key once, on your computer, and keep the file and passwords safe (losing it means a painful key reset with Google):
   `keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`
2. In GitHub: Settings > Secrets and variables > Actions, add `ANDROID_KEYSTORE_BASE64` (`base64 -w0 upload.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (upload) and `ANDROID_KEY_PASSWORD`.
3. Actions > Mobile builds > Run workflow. Download `express-crews-release-aab` and upload it in Play Console (enrol in Play App Signing).

## Push notifications
- Create a Firebase project, add an Android app with id `com.expresscrews.app`, download `google-services.json` and save its contents as the `GOOGLE_SERVICES_JSON` secret (the release workflow writes it in).
- Firebase > Project settings > Service accounts > Generate new private key. Put the whole JSON in Railway as `FCM_SERVICE_ACCOUNT`.
- Booking and message notifications then arrive as pushes on Android. Without these, the apps work and push stays off.
- iOS push needs the Apple Developer account plus Firebase Messaging in the iOS project; not done yet.
