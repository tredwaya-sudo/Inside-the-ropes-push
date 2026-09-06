/**
 * APNs sender via @parse/node-apn.
 * Drops BadDeviceToken / Unregistered devices via callback.
 */

import apn from "@parse/node-apn";
import fs from "node:fs";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** Raw .p8 PEM contents */
  key: string;
  production: boolean;
  dryRun?: boolean;
}

export interface PushPayload {
  deviceToken: string;
  title: string;
  body: string;
  threadId: string;
  notificationId: string;
}

export type InvalidTokenHandler = (token: string, reason: string) => void;

export class ApnsSender {
  private provider: apn.Provider | null = null;
  private readonly config: ApnsConfig;
  private readonly onInvalid: InvalidTokenHandler;
  /** Most recent APNs failure reason. */
  lastError: string | null = null;

  constructor(config: ApnsConfig, onInvalid: InvalidTokenHandler) {
    this.config = config;
    this.onInvalid = onInvalid;
    if (!config.dryRun) {
      this.provider = new apn.Provider({
        token: {
          key: config.key,
          keyId: config.keyId,
          teamId: config.teamId,
        },
        production: config.production,
      });
    }
  }

  async send(payload: PushPayload): Promise<boolean> {
    if (this.config.dryRun || !this.provider) {
      console.log(
        `[apns:dry-run] → ${payload.deviceToken.slice(0, 8)}… ${payload.title}: ${payload.body.slice(0, 80)}`
      );
      return true;
    }

    const note = new apn.Notification();
    note.topic = this.config.bundleId;
    note.alert = { title: payload.title, body: payload.body };
    note.sound = "default";
    note.threadId = payload.threadId;
    // apns-id must be UUID; collapseId replaces same logical alert
    note.collapseId = payload.notificationId.slice(0, 64); // not note.id — apns-id must be UUID
    note.payload = { eventId: payload.threadId, nid: payload.notificationId };

    const result = await this.provider.send(note, payload.deviceToken);
    for (const fail of result.failed) {
      const reason =
        fail.response?.reason ?? fail.error?.message ?? "unknown";
      this.lastError = reason;
      console.warn(
        `[apns] failed ${fail.device?.slice(0, 8)}… reason=${reason}`
      );
      if (
        reason === "BadDeviceToken" ||
        reason === "Unregistered" ||
        reason === "DeviceTokenNotForTopic"
      ) {
        this.onInvalid(fail.device, reason);
      }
    }
    if (result.failed.length === 0) this.lastError = null;
    return result.failed.length === 0;
  }

  async shutdown(): Promise<void> {
    if (this.provider) {
      this.provider.shutdown();
      this.provider = null;
    }
  }
}

export function loadApnsKeyFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (env.APNS_KEY_P8 && env.APNS_KEY_P8.trim()) {
    return env.APNS_KEY_P8.replace(/\\n/g, "\n");
  }
  if (env.APNS_KEY_PATH && env.APNS_KEY_PATH.trim()) {
    return fs.readFileSync(env.APNS_KEY_PATH, "utf8");
  }
  return null;
}
