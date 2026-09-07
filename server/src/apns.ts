/**
 * APNs sender via @parse/node-apn.
 * Supports alert pushes and ActivityKit Live Activity content-state updates.
 * Dual providers: sandbox (Debug) + production (TestFlight / App Store).
 */

import apn from "@parse/node-apn";
import fs from "node:fs";

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** Raw .p8 PEM contents */
  key: string;
  /** Default gateway for alert device tokens when env not specified. */
  production: boolean;
  dryRun?: boolean;
}

export interface PushPayload {
  deviceToken: string;
  title: string;
  body: string;
  threadId: string;
  notificationId: string;
  /** Override gateway for this send. */
  environment?: ApnsEnvironment;
}

export interface LiveActivityPushPayload {
  activityPushToken: string;
  event: "update" | "end";
  contentState: Record<string, unknown>;
  environment: ApnsEnvironment;
  /** Unix timestamp seconds */
  timestamp?: number;
  dismissalDate?: number;
}

export type InvalidTokenHandler = (
  token: string,
  reason: string,
  kind: "alert" | "liveactivity"
) => void;

export class ApnsSender {
  private sandboxProvider: apn.Provider | null = null;
  private productionProvider: apn.Provider | null = null;
  private readonly config: ApnsConfig;
  private readonly onInvalid: InvalidTokenHandler;
  /** Most recent APNs failure reason. */
  lastError: string | null = null;

  constructor(config: ApnsConfig, onInvalid: InvalidTokenHandler) {
    this.config = config;
    this.onInvalid = onInvalid;
    if (!config.dryRun) {
      const token = {
        key: config.key,
        keyId: config.keyId,
        teamId: config.teamId,
      };
      this.sandboxProvider = new apn.Provider({ token, production: false });
      this.productionProvider = new apn.Provider({ token, production: true });
    }
  }

  private providerFor(env?: ApnsEnvironment): apn.Provider | null {
    const useProduction =
      env != null ? env === "production" : this.config.production;
    return useProduction ? this.productionProvider : this.sandboxProvider;
  }

  async send(payload: PushPayload): Promise<boolean> {
    const env: ApnsEnvironment =
      payload.environment ??
      (this.config.production ? "production" : "sandbox");
    if (this.config.dryRun || !this.providerFor(env)) {
      console.log(
        `[apns:dry-run:${env}] → ${payload.deviceToken.slice(0, 8)}… ${payload.title}: ${payload.body.slice(0, 80)}`
      );
      return true;
    }

    const note = new apn.Notification();
    note.topic = this.config.bundleId;
    note.alert = { title: payload.title, body: payload.body };
    note.sound = "cup_drop.caf";
    note.threadId = payload.threadId;
    note.collapseId = payload.notificationId.slice(0, 64);
    note.payload = { eventId: payload.threadId, nid: payload.notificationId };

    const result = await this.providerFor(env)!.send(note, payload.deviceToken);
    return this.handleResult(result, payload.deviceToken, "alert");
  }

  /**
   * ActivityKit push-to-update.
   * Topic: {bundleId}.push-type.liveactivity
   * push-type: liveactivity
   */
  async sendLiveActivity(payload: LiveActivityPushPayload): Promise<boolean> {
    const env = payload.environment;
    const ts = payload.timestamp ?? Math.floor(Date.now() / 1000);
    if (this.config.dryRun || !this.providerFor(env)) {
      console.log(
        `[apns:dry-run:la:${env}] → ${payload.activityPushToken.slice(0, 8)}… event=${payload.event}`
      );
      return true;
    }

    const note = new apn.Notification();
    note.topic = `${this.config.bundleId}.push-type.liveactivity`;
    note.pushType = "liveactivity";
    note.priority = 10;
    note.expiry = ts + 60 * 60;
    const aps: Record<string, unknown> = {
      timestamp: ts,
      event: payload.event,
      "content-state": payload.contentState,
      "relevance-score": 75,
    };
    if (payload.event === "end" && payload.dismissalDate != null) {
      aps["dismissal-date"] = payload.dismissalDate;
    }
    // rawPayload replaces default alert construction
    (note as unknown as { rawPayload: Record<string, unknown> }).rawPayload = {
      aps,
    };

    const result = await this.providerFor(env)!.send(
      note,
      payload.activityPushToken
    );
    return this.handleResult(result, payload.activityPushToken, "liveactivity");
  }

  private handleResult(
    result: { failed: Array<{ device?: string; response?: { reason?: string }; error?: { message?: string } }> },
    token: string,
    kind: "alert" | "liveactivity"
  ): boolean {
    for (const fail of result.failed) {
      const reason =
        fail.response?.reason ?? fail.error?.message ?? "unknown";
      this.lastError = reason;
      console.warn(
        `[apns] failed ${kind} ${(fail.device ?? token).slice(0, 8)}… reason=${reason}`
      );
      if (
        reason === "BadDeviceToken" ||
        reason === "Unregistered" ||
        reason === "DeviceTokenNotForTopic" ||
        reason === "ExpiredToken"
      ) {
        this.onInvalid(fail.device ?? token, reason, kind);
      }
    }
    if (result.failed.length === 0) this.lastError = null;
    return result.failed.length === 0;
  }

  async shutdown(): Promise<void> {
    this.sandboxProvider?.shutdown();
    this.productionProvider?.shutdown();
    this.sandboxProvider = null;
    this.productionProvider = null;
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
