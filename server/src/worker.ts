/**
 * Background poller: every POLL_INTERVAL_MS, fetch Clippd snapshots for
 * subscribed events, diff, filter per device, coalesce, push via APNs.
 */

import type { ApnsSender } from "./apns.js";
import type { ClippdClient } from "./clippd.js";
import type { PushDb } from "./db.js";
import {
  batchNotificationId,
  coalesce,
  diff,
  filterByPreferences,
  filterEvents,
  notificationId,
  pushTitle,
} from "./scoring.js";
import type { ScoreEvent } from "./types.js";

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
    // Kick once immediately, then on interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    // Don't keep the process alive solely for the timer if tests want to exit —
    // but in production the HTTP server keeps us up.
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
    let current;
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

    // First sight of an event is not news.
    const events = diff(previous, current);
    if (events.length === 0) {
      this.log(`${eventId}: no score events`);
      return;
    }
    this.log(`${eventId}: ${events.length} raw event(s)`);

    const devices = this.opts.db
      .listDevices()
      .filter((d) => d.eventIds.includes(eventId) && d.follows.length > 0);

    for (const device of devices) {
      let mine = filterEvents(events, device.follows);
      if (mine.length === 0) continue;

      // Score-type prefs (pars off by default) — same gate as iOS AlertPreferences.
      mine = filterByPreferences(mine, device.alertPreferences);
      if (mine.length === 0) continue;

      const fresh = mine.filter(
        (e) => !this.opts.db.wasDelivered(device.deviceToken, notificationId(e))
      );
      if (fresh.length === 0) continue;

      await this.pushToDevice(device.deviceToken, current.eventName, eventId, fresh);
    }
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

    // Only mark delivered on success so BadMessageId / transient failures retry.
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
