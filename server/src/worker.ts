/**
 * Background poller: every POLL_INTERVAL_MS, fetch Clippd snapshots for
 * subscribed events, diff, filter per device, coalesce, push via APNs.
 * Also pushes ActivityKit Live Scores content-state when followed scores change.
 */

import type { ApnsSender } from "./apns.js";
import type { ClippdClient } from "./clippd.js";
import type { PushDb } from "./db.js";
import {
  buildLiveScoresContentState,
  contentStateFingerprint,
} from "./liveActivity.js";
import {
  batchNotificationId,
  coalesce,
  diff,
  filterByPreferences,
  filterEvents,
  notificationId,
  pushTitle,
} from "./scoring.js";
import type { ScoreEvent, Snapshot } from "./types.js";

export interface WorkerOptions {
  db: PushDb;
  clippd: ClippdClient;
  apns: ApnsSender;
  intervalMs: number;
  log?: (msg: string) => void;
}

export class PollWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly opts: WorkerOptions;
  private readonly log: (msg: string) => void;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[worker] ${m}`));
  }

  start(): void {
    if (this.timer) return;
    this.log(`starting poll every ${this.opts.intervalMs}ms`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.log("skip overlapping tick");
      return;
    }
    this.running = true;
    try {
      const eventIds = this.opts.db.subscribedEventIds();
      if (eventIds.length === 0) {
        this.log("no subscribed events");
        return;
      }
      this.log(`polling ${eventIds.length} event(s)`);
      for (const eventId of eventIds) {
        await this.pollEvent(eventId);
      }
    } catch (err) {
      this.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async pollEvent(eventId: string): Promise<void> {
    const previous = this.opts.db.getSnapshot(eventId);
    let current: Snapshot;
    try {
      current = await this.opts.clippd.snapshot(
        eventId,
        previous?.eventName
      );
    } catch (err) {
      this.log(
        `fetch ${eventId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    this.opts.db.saveSnapshot(current);

    const events = diff(previous, current);
    if (events.length === 0) {
      this.log(`${eventId}: no score events`);
      // Still refresh Live Activities periodically? Skip — fingerprint gate
      // needs a change. No-op when board unchanged.
      return;
    }
    this.log(`${eventId}: ${events.length} raw event(s)`);

    const devices = this.opts.db
      .listDevices()
      .filter((d) => d.eventIds.includes(eventId) && d.follows.length > 0);

    for (const device of devices) {
      const followedEvents = filterEvents(events, device.follows);

      // Alert pushes — gated by score-type preferences.
      let alertEvents = followedEvents;
      if (alertEvents.length > 0) {
        alertEvents = filterByPreferences(alertEvents, device.alertPreferences);
        const fresh = alertEvents.filter(
          (e) => !this.opts.db.wasDelivered(device.deviceToken, notificationId(e))
        );
        if (fresh.length > 0) {
          await this.pushToDevice(
            device.deviceToken,
            current.eventName,
            eventId,
            fresh
          );
        }
      }

      // Live Activity content-state — any followed score change, not alert prefs.
      if (followedEvents.length > 0) {
        await this.pushLiveActivityForDevice(device.deviceToken, device.follows);
      }
    }
  }

  private async pushLiveActivityForDevice(
    deviceToken: string,
    follows: { type: "player" | "team"; id: string; name?: string }[]
  ): Promise<void> {
    const la = this.opts.db.getLiveActivity(deviceToken, "live-scores");
    if (!la) return;

    const device = this.opts.db.getDevice(deviceToken);
    if (!device) return;

    const snapshots: Snapshot[] = [];
    for (const eventId of device.eventIds) {
      const snap = this.opts.db.getSnapshot(eventId);
      if (snap) snapshots.push(snap);
    }
    if (snapshots.length === 0) return;

    const state = buildLiveScoresContentState(follows, snapshots);
    if (!state) {
      // Keep last Lock Screen content on transient empty rebuilds
      // (partial snapshot / board blip). Client owns unfollow teardown.
      this.log(
        `LA skip empty content-state for ${deviceToken.slice(0, 8)}… — retaining activity`
      );
      return;
    }

    const fingerprint = contentStateFingerprint(state);
    if (fingerprint === la.lastFingerprint) {
      this.log(`LA skip identical fingerprint for ${deviceToken.slice(0, 8)}…`);
      return;
    }

    // Strip nulls so Swift optional decoding is happy; keep required fields.
    const contentState = JSON.parse(
      JSON.stringify(state, (_k, v) => (v === null ? undefined : v))
    ) as Record<string, unknown>;

    const allFinished = state.players.every((p) => p.isFinished);
    const ok = await this.opts.apns.sendLiveActivity({
      activityPushToken: la.activityToken,
      event: allFinished ? "end" : "update",
      contentState,
      environment: la.apnsEnvironment,
      dismissalDate: allFinished
        ? Math.floor(Date.now() / 1000) + 3 * 60
        : undefined,
    });

    if (ok) {
      this.opts.db.setLiveActivityFingerprint(
        deviceToken,
        "live-scores",
        fingerprint
      );
      if (allFinished) {
        this.opts.db.deleteLiveActivity(deviceToken, "live-scores");
      }
    }

    this.log(
      `LA ${allFinished ? "end" : "update"} → ${la.activityToken.slice(0, 8)}… ok=${ok} env=${la.apnsEnvironment} lastError=${this.opts.apns.lastError ?? "none"}`
    );
  }

  private async pushToDevice(
    token: string,
    eventName: string,
    eventId: string,
    events: ScoreEvent[]
  ): Promise<void> {
    const lines = coalesce(events, 4);
    if (lines.length === 0) return;

    const body = lines.join("\n");
    const id = batchNotificationId(eventId, events);

    const ok = await this.opts.apns.send({
      deviceToken: token,
      title: pushTitle(eventName, events),
      body,
      threadId: eventId,
      notificationId: id,
    });

    if (ok) {
      this.opts.db.markDelivered(
        token,
        events.map((e) => notificationId(e))
      );
    } else {
      this.log(
        `APNs send failed lastError=${this.opts.apns.lastError ?? "unknown"} — not marking delivered`
      );
    }

    this.log(
      `pushed ${events.length} → ${token.slice(0, 8)}… ok=${ok} id=${id}`
    );
  }
}
