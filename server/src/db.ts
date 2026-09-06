import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { AlertPreferences, DeviceRecord, FollowTarget, Snapshot } from "./types.js";
import { DEFAULT_ALERT_PREFERENCES } from "./types.js";

function mergeAlertPreferences(
  input?: Partial<AlertPreferences> | null
): AlertPreferences {
  return { ...DEFAULT_ALERT_PREFERENCES, ...(input ?? {}) };
}

export class PushDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_token TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform = 'ios'),
        follows_json TEXT NOT NULL DEFAULT '[]',
        event_ids_json TEXT NOT NULL DEFAULT '[]',
        alert_prefs_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        event_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delivered (
        device_token TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (device_token, notification_id)
      );

      CREATE INDEX IF NOT EXISTS idx_delivered_device ON delivered(device_token);
    `);

    // Older installs created devices without alert_prefs_json.
    const cols = this.db
      .prepare(`PRAGMA table_info(devices)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "alert_prefs_json")) {
      this.db.exec(
        `ALTER TABLE devices ADD COLUMN alert_prefs_json TEXT NOT NULL DEFAULT '{}'`
      );
    }
  }

  upsertDevice(input: {
    deviceToken: string;
    platform: "ios";
    follows?: FollowTarget[];
    eventIds?: string[];
    alertPreferences?: AlertPreferences;
  }): DeviceRecord {
    const existing = this.getDevice(input.deviceToken);
    const follows = input.follows ?? existing?.follows ?? [];
    const eventIds = input.eventIds ?? existing?.eventIds ?? [];
    const alertPreferences = mergeAlertPreferences(
      input.alertPreferences ?? existing?.alertPreferences
    );
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO devices (device_token, platform, follows_json, event_ids_json, alert_prefs_json, updated_at)
         VALUES (?, 'ios', ?, ?, ?, ?)
         ON CONFLICT(device_token) DO UPDATE SET
           follows_json = excluded.follows_json,
           event_ids_json = excluded.event_ids_json,
           alert_prefs_json = excluded.alert_prefs_json,
           updated_at = excluded.updated_at`
      )
      .run(
        input.deviceToken,
        JSON.stringify(follows),
        JSON.stringify(eventIds),
        JSON.stringify(alertPreferences),
        updatedAt
      );

    return {
      deviceToken: input.deviceToken,
      platform: "ios",
      follows,
      eventIds,
      alertPreferences,
      updatedAt,
    };
  }

  setFollows(token: string, follows: FollowTarget[]): DeviceRecord | null {
    const existing = this.getDevice(token);
    if (!existing) return null;
    return this.upsertDevice({
      deviceToken: token,
      platform: "ios",
      follows,
      eventIds: existing.eventIds,
      alertPreferences: existing.alertPreferences,
    });
  }

  setEvents(token: string, eventIds: string[]): DeviceRecord | null {
    const existing = this.getDevice(token);
    if (!existing) return null;
    return this.upsertDevice({
      deviceToken: token,
      platform: "ios",
      follows: existing.follows,
      eventIds,
      alertPreferences: existing.alertPreferences,
    });
  }

  setAlertPreferences(
    token: string,
    alertPreferences: AlertPreferences
  ): DeviceRecord | null {
    const existing = this.getDevice(token);
    if (!existing) return null;
    return this.upsertDevice({
      deviceToken: token,
      platform: "ios",
      follows: existing.follows,
      eventIds: existing.eventIds,
      alertPreferences: mergeAlertPreferences(alertPreferences),
    });
  }

  private rowToDevice(row: {
    device_token: string;
    platform: "ios";
    follows_json: string;
    event_ids_json: string;
    alert_prefs_json: string;
    updated_at: string;
  }): DeviceRecord {
    let parsed: Partial<AlertPreferences> = {};
    try {
      parsed = JSON.parse(row.alert_prefs_json || "{}") as Partial<AlertPreferences>;
    } catch {
      parsed = {};
    }
    return {
      deviceToken: row.device_token,
      platform: "ios",
      follows: JSON.parse(row.follows_json) as FollowTarget[],
      eventIds: JSON.parse(row.event_ids_json) as string[],
      alertPreferences: mergeAlertPreferences(parsed),
      updatedAt: row.updated_at,
    };
  }

  getDevice(token: string): DeviceRecord | null {
    const row = this.db
      .prepare(
        `SELECT device_token, platform, follows_json, event_ids_json, alert_prefs_json, updated_at
         FROM devices WHERE device_token = ?`
      )
      .get(token) as
      | {
          device_token: string;
          platform: "ios";
          follows_json: string;
          event_ids_json: string;
          alert_prefs_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return this.rowToDevice(row);
  }

  deleteDevice(token: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM devices WHERE device_token = ?`)
      .run(token);
    this.db.prepare(`DELETE FROM delivered WHERE device_token = ?`).run(token);
    return result.changes > 0;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT device_token, platform, follows_json, event_ids_json, alert_prefs_json, updated_at FROM devices`
      )
      .all() as Array<{
      device_token: string;
      platform: "ios";
      follows_json: string;
      event_ids_json: string;
      alert_prefs_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.rowToDevice(row));
  }

  /** Unique event ids that at least one device wants polled. */
  subscribedEventIds(): string[] {
    const devices = this.listDevices();
    const ids = new Set<string>();
    for (const d of devices) {
      if (d.follows.length === 0) continue;
      for (const id of d.eventIds) ids.add(id);
    }
    return [...ids];
  }

  getSnapshot(eventId: string): Snapshot | null {
    const row = this.db
      .prepare(`SELECT payload_json FROM snapshots WHERE event_id = ?`)
      .get(eventId) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as Snapshot;
  }

  saveSnapshot(snapshot: Snapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (event_id, event_name, payload_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           event_name = excluded.event_name,
           payload_json = excluded.payload_json,
           fetched_at = excluded.fetched_at`
      )
      .run(
        snapshot.eventId,
        snapshot.eventName,
        JSON.stringify(snapshot),
        new Date().toISOString()
      );
  }

  wasDelivered(token: string, notificationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM delivered WHERE device_token = ? AND notification_id = ?`
      )
      .get(token, notificationId) as { ok: number } | undefined;
    return !!row;
  }

  markDelivered(token: string, notificationIds: string[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO delivered (device_token, notification_id, delivered_at)
       VALUES (?, ?, ?)`
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(token, id, now);
    });
    tx(notificationIds);
  }

  close(): void {
    this.db.close();
  }
}
