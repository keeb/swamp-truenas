/**
 * `@keeb/truenas/system` — system-level inventory and service control for a
 * TrueNAS SCALE host.
 *
 * `discover` fans out across `system/info`, `alert/list`, and `service` in a
 * single run and writes one typed resource per object: a single `info`
 * snapshot, one `alert` per active alert, and one `service` per system service.
 * The `service_start` / `service_stop` / `service_restart` methods flip a
 * service and write back its refreshed `service` resource.
 *
 * Every object is its own queryable data instance — e.g.
 * `swamp data query <name> 'attributes.state == "RUNNING"'` — rather than one
 * opaque blob.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ConnectionSchema,
  isoFromTrueNasDate,
  TrueNasClient,
} from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A single snapshot of host-level system information. */
const InfoSchema = z.object({
  hostname: z.string(),
  version: z.string(),
  model: z.string(),
  cores: z.number(),
  physicalCores: z.number(),
  physmem: z.number(),
  uptimeSeconds: z.number(),
  loadavg: z.array(z.number()),
  timezone: z.string(),
  systemProduct: z.string().nullable(),
  systemManufacturer: z.string().nullable(),
  eccMemory: z.boolean(),
}).passthrough();

/** One active alert as reported by `alert/list`. */
const AlertSchema = z.object({
  uuid: z.string(),
  klass: z.string(),
  level: z.string(),
  formatted: z.string().nullable(),
  dismissed: z.boolean(),
  datetime: z.string().nullable(),
}).passthrough();

/** One system service and its run state. */
const ServiceSchema = z.object({
  id: z.number(),
  service: z.string(),
  enable: z.boolean(),
  state: z.string(),
  pids: z.array(z.number()),
}).passthrough();

// ---- Raw API row shapes (only the fields we read) -------------------------

interface RawInfo {
  hostname: string;
  version: string;
  model: string;
  cores: number;
  physical_cores: number;
  physmem: number;
  uptime_seconds: number;
  loadavg: number[];
  timezone: string;
  system_product: string | null;
  system_manufacturer: string | null;
  ecc_memory: boolean;
}

interface RawAlert {
  uuid: string;
  klass: string;
  level: string;
  formatted: string | null;
  dismissed: boolean;
  datetime: { $date?: number } | null;
}

interface RawService {
  id: number;
  service: string;
  enable: boolean;
  state: string;
  pids: number[];
}

/** Minimal shape of the execute context fields these methods use. */
interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function clientFor(ctx: Ctx): TrueNasClient {
  return new TrueNasClient(ctx.globalArgs, ctx.signal);
}

function toServiceRow(s: RawService): z.infer<typeof ServiceSchema> {
  return {
    id: s.id,
    service: s.service,
    enable: s.enable,
    state: s.state,
    pids: s.pids ?? [],
  };
}

/** Perform a service control action, then write back its fresh state. */
async function controlService(
  action: "start" | "stop" | "restart",
  args: { service: string },
  ctx: Ctx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const client = clientFor(ctx);
  await client.post(`service/${action}`, { service: args.service });
  const rows = await client.get<RawService[]>("service");
  const row = rows.find((r) => r.service === args.service);
  if (!row) {
    throw new Error(`Service ${args.service} not found after ${action}`);
  }
  const handle = await ctx.writeResource(
    "service",
    `service-${row.service}`,
    toServiceRow(row),
  );
  ctx.logger?.info("Service {service} -> {state}", {
    service: row.service,
    state: row.state,
  });
  return { dataHandles: [handle] };
}

const ServiceArgs = z.object({
  service: z.string().describe("Service name, e.g. cifs, nfs, ssh, smartd"),
});

/** Model definition for TrueNAS system inventory and service control. */
export const model = {
  type: "@keeb/truenas/system",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    info: {
      description: "Host system information snapshot",
      schema: InfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    alert: {
      description: "One active TrueNAS alert",
      schema: AlertSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    service: {
      description: "One system service and its run state",
      schema: ServiceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read system info, active alerts, and services; write one typed resource per object",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [info, alerts, services] = await Promise.all([
          client.get<RawInfo>("system/info"),
          client.get<RawAlert[]>("alert/list"),
          client.get<RawService[]>("service"),
        ]);

        const handles: Array<{ name: string }> = [];

        handles.push(
          await ctx.writeResource("info", "current", {
            hostname: info.hostname,
            version: info.version,
            model: info.model,
            cores: info.cores,
            physicalCores: info.physical_cores,
            physmem: info.physmem,
            uptimeSeconds: info.uptime_seconds,
            loadavg: info.loadavg,
            timezone: info.timezone,
            systemProduct: info.system_product,
            systemManufacturer: info.system_manufacturer,
            eccMemory: info.ecc_memory,
          }),
        );

        for (const a of alerts) {
          handles.push(
            await ctx.writeResource("alert", `alert-${a.uuid}`, {
              uuid: a.uuid,
              klass: a.klass,
              level: a.level,
              formatted: a.formatted,
              dismissed: a.dismissed,
              datetime: isoFromTrueNasDate(a.datetime),
            }),
          );
        }

        for (const s of services) {
          handles.push(
            await ctx.writeResource(
              "service",
              `service-${s.service}`,
              toServiceRow(s),
            ),
          );
        }

        ctx.logger?.info(
          "Discovered {alerts} alerts, {services} services on {host}",
          {
            alerts: alerts.length,
            services: services.length,
            host: info.hostname,
          },
        );
        return { dataHandles: handles };
      },
    },
    service_start: {
      description: "Start a system service and record its new state",
      arguments: ServiceArgs,
      execute: (args: z.infer<typeof ServiceArgs>, ctx: Ctx) =>
        controlService("start", args, ctx),
    },
    service_stop: {
      description: "Stop a system service and record its new state",
      arguments: ServiceArgs,
      execute: (args: z.infer<typeof ServiceArgs>, ctx: Ctx) =>
        controlService("stop", args, ctx),
    },
    service_restart: {
      description: "Restart a system service and record its new state",
      arguments: ServiceArgs,
      execute: (args: z.infer<typeof ServiceArgs>, ctx: Ctx) =>
        controlService("restart", args, ctx),
    },
  },
};
