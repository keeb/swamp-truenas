/**
 * `@keeb/truenas/accounts` — user and group inventory for a TrueNAS SCALE host.
 *
 * `discover` writes one typed `user` per local account and one typed `group`
 * per group, so you can audit accounts with CEL — e.g. every non-builtin user
 * that is unlocked and has SMB access, or every group with sudo. Read-only:
 * account mutation is deliberately out of scope for now.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One local user account. */
const UserSchema = z.object({
  id: z.number(),
  uid: z.number(),
  username: z.string(),
  builtin: z.boolean(),
  fullName: z.string().nullable(),
  shell: z.string().nullable(),
  locked: z.boolean(),
  smb: z.boolean(),
  email: z.string().nullable(),
  groups: z.array(z.number()),
}).passthrough();

/** One local group. */
const GroupSchema = z.object({
  id: z.number(),
  gid: z.number(),
  group: z.string(),
  builtin: z.boolean(),
  smb: z.boolean(),
  userCount: z.number(),
}).passthrough();

interface RawUser {
  id: number;
  uid: number;
  username: string;
  builtin: boolean;
  full_name: string | null;
  shell: string | null;
  locked: boolean;
  smb: boolean;
  email: string | null;
  groups: number[];
}
interface RawGroup {
  id: number;
  gid: number;
  group: string;
  builtin: boolean;
  smb: boolean;
  users: number[];
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

/** Model definition for TrueNAS account inventory. */
export const model = {
  type: "@keeb/truenas/accounts",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    user: {
      description: "One local user account",
      schema: UserSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    group: {
      description: "One local group",
      schema: GroupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read users and groups; write one typed resource per account and group",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const [users, groups] = await Promise.all([
          client.get<RawUser[]>("user"),
          client.get<RawGroup[]>("group"),
        ]);

        const handles: Array<{ name: string }> = [];
        for (const u of users) {
          handles.push(
            await ctx.writeResource("user", `user-${u.id}`, {
              id: u.id,
              uid: u.uid,
              username: u.username,
              builtin: u.builtin,
              fullName: u.full_name,
              shell: u.shell,
              locked: u.locked,
              smb: u.smb,
              email: u.email,
              groups: u.groups ?? [],
            }),
          );
        }
        for (const g of groups) {
          handles.push(
            await ctx.writeResource("group", `group-${g.id}`, {
              id: g.id,
              gid: g.gid,
              group: g.group,
              builtin: g.builtin,
              smb: g.smb,
              userCount: (g.users ?? []).length,
            }),
          );
        }

        ctx.logger?.info("Discovered {users} users, {groups} groups", {
          users: users.length,
          groups: groups.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
