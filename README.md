# Inside the Ropes — background push pipeline

Monorepo for server-side score polling and Apple Push delivery so followers
get hole updates when the iOS app is not open.

inside-the-ropes-push/
  README.md
  server/     TypeScript Node 20 push API + 60s Clippd poller
  ios/        Drop-in Swift + INTEGRATION.md for the Xcode app

## Product constants

| Item | Value |
|------|-------|
| Bundle id | com.insidetheropes.InsideTheRopes |
| Apple team | K95LALRF9A |
| Clippd host | https://scoreboard.clippd.com |
| Snapshot | GET /api/tournaments/{id}/leaderboards/player |
| Tournament | GET /api/tournaments/{id} |
| Hole count | 18 |

Scoring semantics match the in-app Engine.swift differ (ported in
server/src/scoring.ts).

## Server quick start

cd server
cp .env.example .env
# fill Apple push env vars or set APNS_DRY_RUN=true
npm install
npm test
npm run build
npm start

npm start serves the HTTP API and runs the background worker in-process
(poll every 60s by default). npm run worker is an alias for the same entry.

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | /healthz | Liveness |
| POST | /v1/devices | Register / upsert device |
| PUT | /v1/devices/:token/follows | Replace follow list |
| POST | /v1/devices/:token/events | Replace watched tournament ids |
| DELETE | /v1/devices/:token | Unregister (also on BadDeviceToken) |

Device JSON body:
  deviceToken (string), platform: "ios",
  follows: [{ type: "player"|"team", id, name? }],
  eventIds?: string[]

## Environment

See server/.env.example. Important vars:
- PORT (default 8787), HOST, DATABASE_PATH
- CLIPPD_HOST, POLL_INTERVAL_MS (default 60000)
- APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
- APNS_KEY_PATH or APNS_KEY_P8
- APNS_PRODUCTION (true for App Store / TestFlight production gateway)
- APNS_DRY_RUN (log only, skip Apple)

## Scoring port

server/src/scoring.ts mirrors Engine.swift:
- previous snapshot null/undefined → no events
- holePosted when stroke goes nil→value
- scoreCorrected when value changes
- roundCompleted when holesCompleted hits 18
- filter by FollowTarget player(id) or team(id)
- coalesce up to 4 headlines + "and N more"
- deterministic notificationId; shotgun playIndex sort order

Unit tests: server/tests/scoring.test.ts (vitest). No network required.

## How the worker decides what to poll

Only tournament ids listed on at least one device with non-empty follows
are polled. The iOS app must call POST /v1/devices/:token/events after
opening a leaderboard (see ios/INTEGRATION.md).

## APNs key creation

1. Sign in at developer.apple.com → Certificates, Identifiers & Profiles.
2. Keys → Create a key → enable Apple Push Notifications service (APNs).
3. Download the .p8 once; note the Key ID.
4. Team ID for this app: K95LALRF9A
5. Bundle ID: com.insidetheropes.InsideTheRopes
6. Put the .p8 on the server (or paste PEM into APNS_KEY_P8 with \\n newlines).
7. Set APNS_PRODUCTION=false for sandbox/dev builds; true for TestFlight/App Store.

Invalid tokens (BadDeviceToken / Unregistered) are deleted from SQLite.

## Deploy

Any Node 20+ host works (Fly, Render, a VPS, etc.):
1. Copy server/, install deps, build.
2. Set env (especially Apple push + DATABASE_PATH on persistent volume).
3. Expose PORT over HTTPS; point the iOS app PushAPI.baseURL at it.
4. Keep a single instance (SQLite); or swap the DB layer later for Postgres.

## iOS integration

See ios/INTEGRATION.md for exact steps against
/Users/andrewtredway/Desktop/InsideTheRopes-app copy/InsideTheRopes/
