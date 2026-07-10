/**
 * `@keeb/truenas/apps` — application (chart release) inventory and scaling for a
 * TrueNAS SCALE host.
 *
 * On SCALE 22.12 "Apps" are Helm chart releases on the built-in k3s, exposed at
 * `chart/release`. `discover` writes one typed `app` per release — status,
 * versions, whether an update is available, and desired/available pod counts —
 * so you can query for stopped apps or apps with pending updates. `set_replicas`
 * scales a release (0 to stop, ≥1 to start) and writes back its refreshed state.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, slug, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One application (Helm chart release). */
const AppSchema = z.object({
  id: z.string(),
  name: z.string(),
  catalog: z.string().nullable(),
  train: z.string().nullable(),
  status: z.string(),
  humanVersion: z.string().nullable(),
  chartVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  imageUpdateAvailable: z.boolean(),
  desiredPods: z.number().nullable(),
  availablePods: z.number().nullable(),
}).passthrough();

interface RawApp {
  id: string;
  name: string;
  catalog: string | null;
  catalog_train: string | null;
  status: string;
  human_version: string | null;
  chart_metadata?: { version?: string | null };
  update_available: boolean;
  container_images_update_available: boolean;
  pod_status?: { desired?: number | null; available?: number | null };
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

function toAppRow(a: RawApp): z.infer<typeof AppSchema> {
  return {
    id: a.id,
    name: a.name,
    catalog: a.catalog,
    train: a.catalog_train,
    status: a.status,
    humanVersion: a.human_version,
    chartVersion: a.chart_metadata?.version ?? null,
    updateAvailable: a.update_available,
    imageUpdateAvailable: a.container_images_update_available,
    desiredPods: a.pod_status?.desired ?? null,
    availablePods: a.pod_status?.available ?? null,
  };
}

/** Model definition for TrueNAS application inventory and scaling. */
export const model = {
  type: "@keeb/truenas/apps",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    app: {
      description: "One application (Helm chart release)",
      schema: AppSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read chart releases; write one typed resource per application",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const apps = await client.get<RawApp[]>("chart/release");
        const handles: Array<{ name: string }> = [];
        for (const a of apps) {
          handles.push(
            await ctx.writeResource("app", slug("app", a.id), toAppRow(a)),
          );
        }
        ctx.logger?.info("Discovered {n} apps", { n: apps.length });
        return { dataHandles: handles };
      },
    },
    set_replicas: {
      description:
        "Scale an app to N replicas (0 stops it, >=1 starts it) and record its state",
      arguments: z.object({
        name: z.string().describe("Release name, e.g. minio"),
        replicas: z.number().int().min(0).describe("Desired replica count"),
      }),
      execute: async (
        args: { name: string; replicas: number },
        ctx: Ctx,
      ) => {
        const client = clientFor(ctx);
        await client.post("chart/release/scale", {
          release_name: args.name,
          scale_options: { replica_count: args.replicas },
        });
        // Scaling is asynchronous; re-read the release for its post-scale state.
        const app = await client.get<RawApp>(
          `chart/release/id/${encodeURIComponent(args.name)}`,
        );
        const handle = await ctx.writeResource(
          "app",
          slug("app", app.id),
          toAppRow(app),
        );
        ctx.logger?.info("Scaled {name} to {replicas} replicas", {
          name: args.name,
          replicas: args.replicas,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
