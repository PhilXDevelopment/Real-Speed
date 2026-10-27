# RealSpeed

RealSpeed is an Android-first, local-first GPS speedometer for a phone or tablet mounted safely in a vehicle. Trips and GPS points are stored on the device; the app does not generate sample trips or upload trip data.

## Features

- Live GPS speed using receiver speed fixes through fair (up to 50 m) position accuracy, with movement-derived speed accumulated across multiple fixes when receiver speed is unavailable. Small speeds remain visible instead of being treated as stationary; the display also includes signal quality, trip controls, history, statistics, replay, and GPX/CSV export.
- Background trip recording using Android's location foreground service, with an ongoing notification showing live speed and elapsed ride time.
- MapLibre live map using OpenFreeMap's Liberty style and OpenStreetMap data, with a trip route, heading marker, selected vehicle icon, recenter control, free map panning, and zoom controls.
- Local speed calibration and settings for units, map-follow behavior, route visibility, and default zoom.
- Optional MapLibre offline region management for areas up to a 500 km radius, with a 10,000-tile safeguard that requires lower zoom levels for larger areas. Offline downloads depend on provider availability and terms; the live map requires a network connection.
- GPS quality and movement filtering to suppress stationary drift and implausible speed readings. Distance accumulates from confirmed movement anchors instead of adding every noisy GPS step, and position jumps are checked against reported speed. Saved trips are recalculated once when upgrading to this filtering.
- RealSpeed-branded launcher, splash, and notification icons.

GPS measurements can be inaccurate, stale, or unavailable. Do not treat this app as a certified vehicle instrument. Mount the device safely and do not interact with it while driving.

## Development

1. Install Node.js LTS and Android Studio with an Android SDK.
2. Run `npm install`.
3. Run `npx expo run:android` to build/install the app, or `npx expo run:android --device` for a connected device.
4. Run `npm start` and open the installed development client. Native MapLibre and background location are not supported by Expo Go.
5. Run `npm test` and `npm run typecheck`.

The app uses Expo SDK 58. Rebuild the native app after changing native dependencies or Android native code.

## Downloadable Android builds

The EAS `preview` profile creates an installable APK:

```bash
npm run build:android:preview
```

The `production` profile creates an Android App Bundle for Play Console:

```bash
npm run build:android:production
```

EAS login and Android signing credentials are required. EAS provides the download link when the build completes.

## Background tracking and notifications

Start a trip before switching to another app. Grant foreground and background location permissions and Android notification permission when prompted. A foreground-service notification keeps the location service visible; RealSpeed also displays live speed and elapsed ride time while a trip is active. The RealSpeed trip notification remains ongoing while a ride is recording or paused and is dismissed when the trip is finished.

Battery optimization, force-stop, revoked permissions, disabled location services, OS updates, and device-specific task policies can interrupt recording. Verify behavior on each target device and inspect the saved trip after returning to the app.

## Maps and attribution

The default map style is `https://tiles.openfreemap.org/styles/liberty`, using OpenStreetMap data. The app displays OpenFreeMap and OpenStreetMap attribution. Review provider terms before redistribution or offline/bulk downloads. A provider may change availability or impose usage limits.

Use Map View → Offline Maps to manage region packs. Download areas support a radius of 1–500 km; the app estimates map tiles and rejects requests over the 10,000-tile safeguard with a recommended lower zoom. Packs are stored in MapLibre's native map database, not as MBTiles/PMTiles. Actual provider resource sizes may differ from the tile estimate.

## Speed calibration and map controls

Settings lets you select km/h or mph, configure map follow, route visibility, and default zoom, and RealSpeed automatically applies a ride-aware display calibration based on the selected transport mode. Calibration affects the display only; recorded GPS values remain unchanged. Drag the live map to explore, then use the recenter control to follow the current location again.

## Trip exports and replay

Open History and select a trip to replay its locally stored points, seek the timeline, change playback rate, inspect the speed profile, and share GPX or CSV. GPX track segments preserve pauses and large GPS gaps. Exports contain original recorded GPS values rather than interpolated replay positions.
