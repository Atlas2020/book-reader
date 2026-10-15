# Starlight Reader

Starlight Reader is a static web app that can be installed as a PWA and used offline after its first successful online visit.

## Deploy

This repository is published at [https://atlas2020.github.io/book-reader/](https://atlas2020.github.io/book-reader/). The app files live at the repository root. For another static host, deploy the repository root and keep the folder structure intact, including `icons/`, `images/`, `jszip.min.js`, `manifest.webmanifest`, and `service-worker.js`.

The service worker and app installation do not work from a `file://` URL. Open the deployed HTTPS URL once while online so the app shell is cached, then it can be opened offline.

## Install

- **iPhone/iPad:** Open the HTTPS site in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** Open it in Chrome and choose **Install app** or **Add to Home screen**.
- **Desktop:** Use the browser's install icon or **Install app** menu item.

## Offline and privacy

The app shell and bundled EPUB reader are cached for offline use. Imported books and reading progress are stored in the browser on that device and are not uploaded or synchronized. Users need to import their books separately on each device.

Speech voices are provided by the operating system/browser. Their availability and offline behavior depend on the device and installed voice packs.

`jszip.min.js` is bundled locally for offline EPUB support. See `JSZIP-LICENSE.txt` for its license.
