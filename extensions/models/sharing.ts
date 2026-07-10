/**
 * `@keeb/truenas/sharing` — SMB, NFS, and iSCSI share inventory and control for
 * a TrueNAS SCALE host.
 *
 * `discover` writes one typed resource per share across all three protocols:
 * `smb`, `nfs`, and `iscsiTarget`. `smb_set_enabled` / `nfs_set_enabled` flip a
 * share's enabled flag and write back its refreshed resource. Because every
 * share is its own queryable record, you can ask questions like "every enabled
 * NFS export with no host allowlist" directly with a CEL predicate.
 *
 * Note: on TrueNAS 22.12 an NFS share exposes a single `path`; newer releases
 * use a `paths` array. This model reads `path` and falls back to the first
 * `paths` entry so it works across versions.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One SMB (CIFS) share. */
const SmbSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  readonly: z.boolean(),
  guestok: z.boolean(),
  purpose: z.string().nullable(),
  comment: z.string().nullable(),
}).passthrough();

/** One NFS export. */
const NfsSchema = z.object({
  id: z.number(),
  path: z.string().nullable(),
  enabled: z.boolean(),
  readonly: z.boolean(),
  networks: z.array(z.string()),
  hosts: z.array(z.string()),
  comment: z.string().nullable(),
}).passthrough();

/** One iSCSI target. */
const IscsiTargetSchema = z.object({
  id: z.number(),
  name: z.string(),
  alias: z.string().nullable(),
  mode: z.string().nullable(),
}).passthrough();

// ---- Raw API row shapes ---------------------------------------------------

interface RawSmb {
  id: number;
  name: string;
  path: string;
  enabled: boolean;
  ro: boolean;
  guestok: boolean;
  purpose: string | null;
  comment: string | null;
}
interface RawNfs {
  id: number;
  path?: string | null;
  paths?: string[] | null;
  enabled: boolean;
  ro: boolean;
  networks: string[];
  hosts: string[];
  comment: string | null;
}
interface RawIscsiTarget {
  id: number;
  name: string;
  alias: string | null;
  mode: string | null;
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

const nfsPath = (n: RawNfs): string | null =>
  n.path ?? (n.paths && n.paths.length ? n.paths[0] : null);

function toSmbRow(s: RawSmb): z.infer<typeof SmbSchema> {
  return {
    id: s.id,
    name: s.name,
    path: s.path,
    enabled: s.enabled,
    readonly: s.ro,
    guestok: s.guestok,
    purpose: s.purpose,
    comment: s.comment,
  };
}
function toNfsRow(n: RawNfs): z.infer<typeof NfsSchema> {
  return {
    id: n.id,
    path: nfsPath(n),
    enabled: n.enabled,
    readonly: n.ro,
    networks: n.networks ?? [],
    hosts: n.hosts ?? [],
    comment: n.comment,
  };
}

/** Flip a share's `enabled` flag via PUT and write back the fresh row. */
async function setEnabled(
  proto: "smb" | "nfs",
  args: { id: number; enabled: boolean },
  ctx: Ctx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const client = clientFor(ctx);
  const updated = await client.put<RawSmb & RawNfs>(
    `sharing/${proto}/id/${args.id}`,
    { enabled: args.enabled },
  );
  const handle = proto === "smb"
    ? await ctx.writeResource("smb", `smb-${updated.id}`, toSmbRow(updated))
    : await ctx.writeResource("nfs", `nfs-${updated.id}`, toNfsRow(updated));
  ctx.logger?.info("{proto} share {id} enabled={enabled}", {
    proto,
    id: args.id,
    enabled: args.enabled,
  });
  return { dataHandles: [handle] };
}

const EnableArgs = z.object({
  id: z.number().describe("Share id"),
  enabled: z.boolean().describe("Desired enabled state"),
});

/** Model definition for TrueNAS share management. */
export const model = {
  type: "@keeb/truenas/sharing",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    smb: {
      description: "One SMB (CIFS) share",
      schema: SmbSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    nfs: {
      description: "One NFS export",
      schema: NfsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    iscsiTarget: {
      description: "One iSCSI target",
      schema: IscsiTargetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read SMB, NFS, and iSCSI shares; write one typed resource per share",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [smb, nfs, iscsi] = await Promise.all([
          client.get<RawSmb[]>("sharing/smb"),
          client.get<RawNfs[]>("sharing/nfs"),
          client.get<RawIscsiTarget[]>("iscsi/target"),
        ]);

        const handles: Array<{ name: string }> = [];
        for (const s of smb) {
          handles.push(
            await ctx.writeResource("smb", `smb-${s.id}`, toSmbRow(s)),
          );
        }
        for (const n of nfs) {
          handles.push(
            await ctx.writeResource("nfs", `nfs-${n.id}`, toNfsRow(n)),
          );
        }
        for (const t of iscsi) {
          handles.push(
            await ctx.writeResource("iscsiTarget", `iscsi-${t.id}`, {
              id: t.id,
              name: t.name,
              alias: t.alias,
              mode: t.mode,
            }),
          );
        }

        ctx.logger?.info(
          "Discovered {smb} SMB, {nfs} NFS, {iscsi} iSCSI shares",
          { smb: smb.length, nfs: nfs.length, iscsi: iscsi.length },
        );
        return { dataHandles: handles };
      },
    },
    smb_set_enabled: {
      description: "Enable or disable an SMB share and record its new state",
      arguments: EnableArgs,
      execute: (args: z.infer<typeof EnableArgs>, ctx: Ctx) =>
        setEnabled("smb", args, ctx),
    },
    nfs_set_enabled: {
      description: "Enable or disable an NFS export and record its new state",
      arguments: EnableArgs,
      execute: (args: z.infer<typeof EnableArgs>, ctx: Ctx) =>
        setEnabled("nfs", args, ctx),
    },
  },
};
