import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PushDb } from "./db.js";

const followSchema = z.object({
  type: z.enum(["player", "team"]),
  id: z.string().min(1),
  name: z.string().optional(),
});

const registerSchema = z.object({
  deviceToken: z.string().min(8),
  platform: z.literal("ios"),
  follows: z.array(followSchema).optional(),
  eventIds: z.array(z.string().min(1)).optional(),
});

const followsBodySchema = z.object({
  follows: z.array(followSchema),
});

const eventsBodySchema = z.object({
  eventIds: z.array(z.string().min(1)),
});

export function createRouter(db: PushDb): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "inside-the-ropes-push" });
  });

  router.post("/v1/devices", (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const device = db.upsertDevice(parsed.data);
    res.status(201).json(device);
  });

  router.put("/v1/devices/:token/follows", (req: Request, res: Response) => {
    const parsed = followsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const device = db.setFollows(req.params.token!, parsed.data.follows);
    if (!device) {
      res.status(404).json({ error: "device not found" });
      return;
    }
    res.json(device);
  });

  router.post("/v1/devices/:token/events", (req: Request, res: Response) => {
    const parsed = eventsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const device = db.setEvents(req.params.token!, parsed.data.eventIds);
    if (!device) {
      res.status(404).json({ error: "device not found" });
      return;
    }
    res.json(device);
  });

  router.delete("/v1/devices/:token", (req: Request, res: Response) => {
    const deleted = db.deleteDevice(req.params.token!);
    if (!deleted) {
      res.status(404).json({ error: "device not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
