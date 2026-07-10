/**
 * `@keeb/truenas/storage` — ZFS pool, dataset, and snapshot management for a
 * TrueNAS SCALE host.
 *
 * `discover` writes one typed `pool` per pool and one typed `dataset` per
 * dataset (the API returns datasets as a recursive tree; this flattens it). The
 * heavier snapshot enumeration lives in its own `discover_snapshots` method with
 * an optional dataset filter, so a routine sweep stays cheap. Mutating methods —
 * `create_dataset`, `delete_dataset`, `create_snapshot`, `delete_snapshot` —
 * verify the target's live state before acting and write back the affected
 * resource.
 *
 * `discover_disks` writes one typed `disk` per physical drive with its SMART
 * status and current temperature. The `pool` resource carries redundancy
 * (vdev layout, fault tolerance) and last-scrub state, so pool health is
 * queryable, not just capacity.
 *
 * Sizes are stored twice: `*Bytes` (numeric, for CEL thresholds like
 * `attributes.usedBytes > 1e12`) and a human string (for reports).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, slug, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One ZFS pool: capacity, health, redundancy, and last-scrub state. */
const PoolSchema = z.object({
  name: z.string(),
  status: z.string(),
  healthy: z.boolean(),
  sizeBytes: z.number(),
  allocatedBytes: z.number(),
  freeBytes: z.number(),
  capacityPercent: z.number(),
  fragmentationPercent: z.number().nullable(),
  encrypted: z.boolean(),
  // Redundancy summary derived from the data vdev topology.
  vdevLayout: z.string(), // e.g. "1 x RAIDZ1 (4 disks)"
  dataVdevType: z.string().nullable(), // RAIDZ1 | MIRROR | STRIPE | …
  faultTolerance: z.number().nullable(), // disks that can fail per vdev
  // Last scrub/resilver.
  scanFunction: z.string().nullable(),
  scanState: z.string().nullable(),
  scanEnd: z.string().nullable(),
  scanErrors: z.number().nullable(),
}).passthrough();

/** One physical disk, with SMART health and temperature. */
const DiskSchema = z.object({
  name: z.string(),
  type: z.string(), // HDD | SSD
  model: z.string().nullable(),
  serial: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  size: z.string().nullable(),
  rotationRate: z.number().nullable(),
  smartEnabled: z.boolean().nullable(),
  smartStatus: z.string().nullable(), // latest SMART test result, or UNKNOWN
  temperatureC: z.number().nullable(),
  pool: z.string().nullable(), // pool this disk is a member of, if any
}).passthrough();

/** One ZFS dataset (or zvol), flattened out of the API's recursive tree. */
const DatasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  pool: z.string(),
  type: z.string(),
  mountpoint: z.string().nullable(),
  encrypted: z.boolean(),
  locked: z.boolean(),
  readonly: z.boolean().nullable(),
  compression: z.string().nullable(),
  usedBytes: z.number().nullable(),
  used: z.string().nullable(),
  availableBytes: z.number().nullable(),
  available: z.string().nullable(),
  quotaBytes: z.number().nullable(),
}).passthrough();

/** One ZFS snapshot. */
const SnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  dataset: z.string(),
  snapshotName: z.string(),
  usedBytes: z.number().nullable(),
  used: z.string().nullable(),
}).passthrough();

// ---- Raw API row shapes ---------------------------------------------------

interface ZfsProp {
  parsed: number | string | null;
  value: string | null;
}
interface RawVdev {
  type: string; // RAIDZ1 | MIRROR | DISK | …
  status?: string;
  children?: unknown[];
}
interface RawPool {
  name: string;
  status: string;
  healthy: boolean;
  size: number;
  allocated: number;
  free: number;
  encrypt: number;
  fragmentation?: string | number | null;
  topology?: { data?: RawVdev[] };
  scan?: {
    function?: string | null;
    state?: string | null;
    end_time?: { $date?: number } | null;
    errors?: number | null;
  } | null;
}
interface RawDisk {
  name: string;
  type: string;
  model: string | null;
  serial: string | null;
  size: number | null;
  rotationrate: number | null;
  togglesmart: boolean | null;
  pool: string | null;
}
interface RawSmartResult {
  disk: string;
  tests?: Array<{ status?: string }>;
}
interface RawDataset {
  id: string;
  name: string;
  pool: string;
  type: string;
  mountpoint: string | null;
  encrypted: boolean;
  locked: boolean;
  readonly?: ZfsProp;
  compression?: ZfsProp;
  used?: ZfsProp;
  available?: ZfsProp;
  quota?: ZfsProp;
  children?: RawDataset[];
}
interface RawSnapshot {
  id: string;
  name: string;
  dataset: string;
  snapshot_name: string;
  properties?: { used?: ZfsProp };
}

/** Minimal execute-context shape used by this model's methods. */
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

const numProp = (p?: ZfsProp): number | null =>
  p && typeof p.parsed === "number" ? p.parsed : null;
const strProp = (p?: ZfsProp): string | null => {
  if (!p) return null;
  if (typeof p.parsed === "string") return p.parsed;
  return p.value;
};

/**
 * Flatten the dataset tree into a de-duplicated list keyed by id. TrueNAS
 * returns each dataset both at the top level and nested under its parent's
 * `children`, so a naive walk visits children twice — the Map collapses them.
 */
function flattenDatasets(nodes: RawDataset[]): RawDataset[] {
  const byId = new Map<string, RawDataset>();
  const walk = (list: RawDataset[]) => {
    for (const n of list) {
      byId.set(n.id, n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return [...byId.values()];
}

function toDatasetRow(d: RawDataset): z.infer<typeof DatasetSchema> {
  return {
    id: d.id,
    name: d.name,
    pool: d.pool,
    type: d.type,
    mountpoint: d.mountpoint,
    encrypted: d.encrypted,
    locked: d.locked,
    readonly: d.readonly ? d.readonly.value === "on" : null,
    compression: strProp(d.compression),
    usedBytes: numProp(d.used),
    used: d.used?.value ?? null,
    availableBytes: numProp(d.available),
    available: d.available?.value ?? null,
    quotaBytes: numProp(d.quota),
  };
}

/** Disks a single vdev of the given type can lose without data loss. */
function faultToleranceFor(type: string, diskCount: number): number | null {
  switch (type.toUpperCase()) {
    case "RAIDZ1":
      return 1;
    case "RAIDZ2":
      return 2;
    case "RAIDZ3":
      return 3;
    case "MIRROR":
      return Math.max(diskCount - 1, 0);
    case "DISK":
    case "STRIPE":
      return 0;
    default:
      return null;
  }
}

const pct = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function toPoolRow(p: RawPool): z.infer<typeof PoolSchema> {
  const dataVdevs = p.topology?.data ?? [];
  const firstType = dataVdevs[0]?.type ?? null;
  // Summarize the data layout, grouping identical vdevs (e.g. "2 x MIRROR (2 disks)").
  const groups = new Map<string, number>();
  for (const v of dataVdevs) {
    const disks = Array.isArray(v.children) ? v.children.length : 1;
    const key = `${v.type} (${disks} disks)`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const vdevLayout = [...groups.entries()]
    .map(([k, n]) => `${n} x ${k}`).join(" + ") || "unknown";
  const firstDisks = Array.isArray(dataVdevs[0]?.children)
    ? dataVdevs[0]!.children!.length
    : 1;
  return {
    name: p.name,
    status: p.status,
    healthy: p.healthy,
    sizeBytes: p.size,
    allocatedBytes: p.allocated,
    freeBytes: p.free,
    capacityPercent: p.size > 0 ? Math.round((p.allocated / p.size) * 100) : 0,
    fragmentationPercent: pct(p.fragmentation),
    encrypted: p.encrypt > 0,
    vdevLayout,
    dataVdevType: firstType,
    faultTolerance: firstType ? faultToleranceFor(firstType, firstDisks) : null,
    scanFunction: p.scan?.function ?? null,
    scanState: p.scan?.state ?? null,
    scanEnd: isoFromDate(p.scan?.end_time),
    scanErrors: p.scan?.errors ?? null,
  };
}

function isoFromDate(v: { $date?: number } | null | undefined): string | null {
  return v && typeof v.$date === "number"
    ? new Date(v.$date).toISOString()
    : null;
}

/** TrueNAS ids embed `/` and `@`; encode them for use in a REST path. */
const encId = (id: string) => encodeURIComponent(id);

/** Model definition for TrueNAS ZFS storage management. */
export const model = {
  type: "@keeb/truenas/storage",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pool: {
      description: "One ZFS pool with capacity and health",
      schema: PoolSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dataset: {
      description: "One ZFS dataset or zvol",
      schema: DatasetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    snapshot: {
      description: "One ZFS snapshot",
      schema: SnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    disk: {
      description: "One physical disk with SMART health and temperature",
      schema: DiskSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read pools and datasets; write one typed resource per pool and dataset",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [pools, datasetTree] = await Promise.all([
          client.get<RawPool[]>("pool"),
          client.get<RawDataset[]>("pool/dataset"),
        ]);

        const handles: Array<{ name: string }> = [];
        for (const p of pools) {
          handles.push(
            await ctx.writeResource("pool", `pool-${p.name}`, toPoolRow(p)),
          );
        }

        const datasets = flattenDatasets(datasetTree);
        for (const d of datasets) {
          handles.push(
            await ctx.writeResource(
              "dataset",
              slug("dataset", d.id),
              toDatasetRow(d),
            ),
          );
        }

        ctx.logger?.info("Discovered {pools} pools, {datasets} datasets", {
          pools: pools.length,
          datasets: datasets.length,
        });
        return { dataHandles: handles };
      },
    },
    discover_disks: {
      description:
        "Read physical disks with SMART status and temperature; one typed resource per disk",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [disks, temps, smart] = await Promise.all([
          client.get<RawDisk[]>("disk"),
          client.post<Record<string, number | null>>("disk/temperatures", {}),
          client.get<RawSmartResult[]>("smart/test/results").catch(() =>
            [] as RawSmartResult[]
          ),
        ]);

        // Latest SMART test status per disk name.
        const smartByDisk = new Map<string, string>();
        for (const r of smart) {
          const last = r.tests?.[r.tests.length - 1];
          if (last?.status) smartByDisk.set(r.disk, last.status);
        }

        const handles: Array<{ name: string }> = [];
        for (const d of disks) {
          handles.push(
            await ctx.writeResource("disk", `disk-${d.name}`, {
              name: d.name,
              type: d.type,
              model: d.model,
              serial: d.serial,
              sizeBytes: d.size,
              size: d.size != null
                ? `${Math.round(d.size / 1e11) / 10} TB`
                : null,
              rotationRate: d.rotationrate,
              smartEnabled: d.togglesmart,
              smartStatus: smartByDisk.get(d.name) ?? "UNKNOWN",
              temperatureC: temps?.[d.name] ?? null,
              pool: d.pool,
            }),
          );
        }
        ctx.logger?.info("Discovered {n} disks", { n: disks.length });
        return { dataHandles: handles };
      },
    },
    discover_snapshots: {
      description:
        "Enumerate ZFS snapshots (optionally filtered to one dataset) as typed resources",
      arguments: z.object({
        dataset: z.string().optional().describe(
          "Only snapshots of this dataset (exact match), e.g. main/storage",
        ),
      }),
      execute: async (args: { dataset?: string }, ctx: Ctx) => {
        const client = clientFor(ctx);
        const all = await client.get<RawSnapshot[]>("zfs/snapshot");
        const rows = args.dataset
          ? all.filter((s) => s.dataset === args.dataset)
          : all;

        const handles: Array<{ name: string }> = [];
        for (const s of rows) {
          handles.push(
            await ctx.writeResource("snapshot", slug("snapshot", s.id), {
              id: s.id,
              name: s.name,
              dataset: s.dataset,
              snapshotName: s.snapshot_name,
              usedBytes: numProp(s.properties?.used),
              used: s.properties?.used?.value ?? null,
            }),
          );
        }
        ctx.logger?.info("Discovered {n} snapshots{scope}", {
          n: rows.length,
          scope: args.dataset ? ` for ${args.dataset}` : "",
        });
        return { dataHandles: handles };
      },
    },
    create_dataset: {
      description: "Create a ZFS dataset and record it",
      arguments: z.object({
        name: z.string().describe("Full dataset path, e.g. main/media"),
        comments: z.string().optional(),
        compression: z.string().optional().describe(
          "e.g. LZ4, ZSTD, OFF (inherits parent when omitted)",
        ),
      }),
      execute: async (
        args: { name: string; comments?: string; compression?: string },
        ctx: Ctx,
      ) => {
        const client = clientFor(ctx);
        const body: Record<string, unknown> = { name: args.name };
        if (args.comments !== undefined) body.comments = args.comments;
        if (args.compression !== undefined) body.compression = args.compression;
        const created = await client.post<RawDataset>("pool/dataset", body);
        const handle = await ctx.writeResource(
          "dataset",
          slug("dataset", created.id),
          toDatasetRow(created),
        );
        ctx.logger?.info("Created dataset {name}", { name: created.id });
        return { dataHandles: [handle] };
      },
    },
    delete_dataset: {
      description:
        "Delete a ZFS dataset after verifying it exists (fails if missing)",
      arguments: z.object({
        id: z.string().describe("Dataset id/path, e.g. main/media"),
        recursive: z.boolean().default(false).describe(
          "Also delete child datasets",
        ),
      }),
      execute: async (
        args: { id: string; recursive: boolean },
        ctx: Ctx,
      ) => {
        const client = clientFor(ctx);
        // Verify-before-destroy: confirm the dataset exists first.
        await client.get<RawDataset>(`pool/dataset/id/${encId(args.id)}`);
        await client.del(`pool/dataset/id/${encId(args.id)}`, {
          recursive: args.recursive,
        });
        ctx.logger?.info("Deleted dataset {id} (recursive={recursive})", {
          id: args.id,
          recursive: args.recursive,
        });
        return { dataHandles: [] };
      },
    },
    create_snapshot: {
      description: "Create a ZFS snapshot and record it",
      arguments: z.object({
        dataset: z.string().describe("Dataset to snapshot, e.g. main/storage"),
        name: z.string().describe("Snapshot name (the part after @)"),
        recursive: z.boolean().default(false),
      }),
      execute: async (
        args: { dataset: string; name: string; recursive: boolean },
        ctx: Ctx,
      ) => {
        const client = clientFor(ctx);
        const created = await client.post<RawSnapshot>("zfs/snapshot", {
          dataset: args.dataset,
          name: args.name,
          recursive: args.recursive,
        });
        const handle = await ctx.writeResource(
          "snapshot",
          slug("snapshot", created.id),
          {
            id: created.id,
            name: created.name,
            dataset: created.dataset,
            snapshotName: created.snapshot_name,
            usedBytes: numProp(created.properties?.used),
            used: created.properties?.used?.value ?? null,
          },
        );
        ctx.logger?.info("Created snapshot {id}", { id: created.id });
        return { dataHandles: [handle] };
      },
    },
    delete_snapshot: {
      description: "Delete a ZFS snapshot by its full id (dataset@name)",
      arguments: z.object({
        id: z.string().describe("Full snapshot id, e.g. main/storage@daily-1"),
      }),
      execute: async (args: { id: string }, ctx: Ctx) => {
        const client = clientFor(ctx);
        await client.del(`zfs/snapshot/id/${encId(args.id)}`);
        ctx.logger?.info("Deleted snapshot {id}", { id: args.id });
        return { dataHandles: [] };
      },
    },
  },
};
