/**
 * `@keeb/truenas/protection` — data-protection task inventory for a TrueNAS
 * SCALE host: periodic snapshot tasks, replication, cloud sync, and rsync.
 *
 * `discover` writes one typed resource per task across all four kinds
 * (`snapshotTask`, `replication`, `cloudSync`, `rsyncTask`) so you can audit
 * coverage — e.g. datasets with no snapshot task, or disabled replication.
 * Read-only.
 *
 * Schemas assert only the always-present identity/enabled/schedule fields and
 * use passthrough, so the full task payload is preserved even where releases
 * differ in the optional fields.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A cron-style schedule as TrueNAS returns it. */
const ScheduleSchema = z.object({
  minute: z.string().optional(),
  hour: z.string().optional(),
  dom: z.string().optional(),
  month: z.string().optional(),
  dow: z.string().optional(),
}).passthrough().nullable();

/** One periodic snapshot task. */
const SnapshotTaskSchema = z.object({
  id: z.number(),
  dataset: z.string().nullable(),
  recursive: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  namingSchema: z.string().nullable(),
  lifetimeValue: z.number().nullable(),
  lifetimeUnit: z.string().nullable(),
  schedule: ScheduleSchema,
}).passthrough();

/** One replication task. */
const ReplicationSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  direction: z.string().nullable(),
  transport: z.string().nullable(),
  enabled: z.boolean().nullable(),
  sourceDatasets: z.array(z.string()).nullable(),
  targetDataset: z.string().nullable(),
}).passthrough();

/** One cloud sync task. */
const CloudSyncSchema = z.object({
  id: z.number(),
  description: z.string().nullable(),
  direction: z.string().nullable(),
  path: z.string().nullable(),
  enabled: z.boolean().nullable(),
  schedule: ScheduleSchema,
}).passthrough();

/** One rsync task. */
const RsyncTaskSchema = z.object({
  id: z.number(),
  path: z.string().nullable(),
  remotehost: z.string().nullable(),
  direction: z.string().nullable(),
  enabled: z.boolean().nullable(),
  schedule: ScheduleSchema,
}).passthrough();

interface RawSnapshotTask {
  id: number;
  dataset?: string | null;
  recursive?: boolean | null;
  enabled?: boolean | null;
  naming_schema?: string | null;
  lifetime_value?: number | null;
  lifetime_unit?: string | null;
  schedule?: Record<string, unknown> | null;
}
interface RawReplication {
  id: number;
  name?: string | null;
  direction?: string | null;
  transport?: string | null;
  enabled?: boolean | null;
  source_datasets?: string[] | null;
  target_dataset?: string | null;
}
interface RawCloudSync {
  id: number;
  description?: string | null;
  direction?: string | null;
  path?: string | null;
  enabled?: boolean | null;
  schedule?: Record<string, unknown> | null;
}
interface RawRsyncTask {
  id: number;
  path?: string | null;
  remotehost?: string | null;
  direction?: string | null;
  enabled?: boolean | null;
  schedule?: Record<string, unknown> | null;
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
}

const clientFor = (ctx: Ctx) => new TrueNasClient(ctx.globalArgs, ctx.signal);

/** Model definition for TrueNAS data-protection task inventory. */
export const model = {
  type: "@keeb/truenas/protection",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshotTask: {
      description: "One periodic ZFS snapshot task",
      schema: SnapshotTaskSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    replication: {
      description: "One replication task",
      schema: ReplicationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cloudSync: {
      description: "One cloud sync task",
      schema: CloudSyncSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    rsyncTask: {
      description: "One rsync task",
      schema: RsyncTaskSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read snapshot, replication, cloud sync, and rsync tasks as typed resources",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [snaps, repls, clouds, rsyncs] = await Promise.all([
          client.get<RawSnapshotTask[]>("pool/snapshottask"),
          client.get<RawReplication[]>("replication"),
          client.get<RawCloudSync[]>("cloudsync"),
          client.get<RawRsyncTask[]>("rsynctask"),
        ]);

        const handles: Array<{ name: string }> = [];
        for (const s of snaps) {
          handles.push(
            await ctx.writeResource("snapshotTask", `snapshottask-${s.id}`, {
              id: s.id,
              dataset: s.dataset ?? null,
              recursive: s.recursive ?? null,
              enabled: s.enabled ?? null,
              namingSchema: s.naming_schema ?? null,
              lifetimeValue: s.lifetime_value ?? null,
              lifetimeUnit: s.lifetime_unit ?? null,
              schedule: s.schedule ?? null,
            }),
          );
        }
        for (const r of repls) {
          handles.push(
            await ctx.writeResource("replication", `replication-${r.id}`, {
              id: r.id,
              name: r.name ?? null,
              direction: r.direction ?? null,
              transport: r.transport ?? null,
              enabled: r.enabled ?? null,
              sourceDatasets: r.source_datasets ?? null,
              targetDataset: r.target_dataset ?? null,
            }),
          );
        }
        for (const c of clouds) {
          handles.push(
            await ctx.writeResource("cloudSync", `cloudsync-${c.id}`, {
              id: c.id,
              description: c.description ?? null,
              direction: c.direction ?? null,
              path: c.path ?? null,
              enabled: c.enabled ?? null,
              schedule: c.schedule ?? null,
            }),
          );
        }
        for (const t of rsyncs) {
          handles.push(
            await ctx.writeResource("rsyncTask", `rsynctask-${t.id}`, {
              id: t.id,
              path: t.path ?? null,
              remotehost: t.remotehost ?? null,
              direction: t.direction ?? null,
              enabled: t.enabled ?? null,
              schedule: t.schedule ?? null,
            }),
          );
        }

        ctx.logger?.info(
          "Discovered {snaps} snapshot tasks, {repls} replications, {clouds} cloud syncs, {rsyncs} rsync tasks",
          {
            snaps: snaps.length,
            repls: repls.length,
            clouds: clouds.length,
            rsyncs: rsyncs.length,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
