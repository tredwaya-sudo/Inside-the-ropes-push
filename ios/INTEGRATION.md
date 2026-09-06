# Integration

Target Xcode project path:
/Users/andrewtredway/Desktop/InsideTheRopes-app copy/InsideTheRopes/

App sources live under InsideTheRopes/InsideTheRopes/

## 1. Xcode project setup

1. Open InsideTheRopes.xcodeproj.
2. Select the InsideTheRopes target, Signing and Capabilities.
3. Confirm Team is K95LALRF9A.
4. Confirm Bundle Identifier is com.insidetheropes.InsideTheRopes.
5. Add the Push Notifications capability.
6. Add Background Modes and enable Remote notifications.

## 2. Add the drop-in Swift files

Copy into the app group (same folder as AppStore.swift):

- PushAPI.swift
- PushRegistration.swift

In Xcode: File, Add Files to InsideTheRopes, select both, check the app target.

Example copy commands:

cp ios/PushAPI.swift "/Users/andrewtredway/Desktop/InsideTheRopes-app copy/InsideTheRopes/InsideTheRopes/"
cp ios/PushRegistration.swift "/Users/andrewtredway/Desktop/InsideTheRopes-app copy/InsideTheRopes/InsideTheRopes/"

## 3. Patch existing sources

Apply snippets under ios/patches/:

- InsideTheRopesApp.swift: AppDelegate adaptor, PushAPI.baseURL, register on active
- AppStore.swift: sync follows on toggle, sync events on loadEvent, register after requestAlerts, add syncPushRegistration()
- FollowingView.swift: update alerts footer copy for background delivery

Snippet files:

- patches/InsideTheRopesApp.swift.snippet
- patches/AppStore.swift.snippet
- patches/FollowingView.swift.snippet

## 4. Point at the push server

In InsideTheRopesApp.init() set PushAPI.baseURL.

DEBUG example: http://127.0.0.1:8787
RELEASE example: https://YOUR-PUSH-HOST

On a physical device in DEBUG, use your Mac LAN IP instead of loopback.

## 5. Event subscription

The worker only polls event ids registered on the device.
Opening a live leaderboard (loadEvent then sync events) subscribes the device.
Follows alone are not enough.

## 6. Verify

See root README for an end-to-end checklist.

## 7. Apple key material

See root README for .p8 key creation. Team K95LALRF9A, bundle com.insidetheropes.InsideTheRopes.
