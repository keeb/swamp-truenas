/**
 * `@keeb/truenas/network` — network interface inventory for a TrueNAS SCALE host.
 *
 * `discover` writes one typed `interface` resource per NIC, flattening the
 * nested `state` object into flat fields: link state, active media, MTU, the
 * MAC (from the `LINK` alias), and the list of configured IP addresses (from
 * `INET`/`INET6` aliases). That makes questions like "every interface that is
 * up but has no IP" a one-line CEL predicate. Read-only.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { ConnectionSchema, TrueNasClient } from "./lib/client.ts";

const GlobalArgsSchema = ConnectionSchema;
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One network interface with its live state flattened out. */
const InterfaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  linkState: z.string().nullable(),
  activeMedia: z.string().nullable(),
  mtu: z.number().nullable(),
  mac: z.string().nullable(),
  addresses: z.array(z.string()),
}).passthrough();

interface RawAlias {
  type: string; // LINK | INET | INET6
  address: string;
  netmask?: number;
}
interface RawInterface {
  id: string;
  name: string;
  type: string;
  state?: {
    link_state?: string | null;
    active_media_type?: string | null;
    mtu?: number | null;
    aliases?: RawAlias[];
  };
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

/** Model definition for TrueNAS network interface inventory. */
export const model = {
  type: "@keeb/truenas/network",
  version: "2026.07.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    interface: {
      description: "One network interface with live link state and addresses",
      schema: InterfaceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Read network interfaces; write one typed resource per interface",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const client = clientFor(ctx);
        const ifaces = await client.get<RawInterface[]>("interface");

        const handles: Array<{ name: string }> = [];
        for (const i of ifaces) {
          const aliases = i.state?.aliases ?? [];
          const mac = aliases.find((a) => a.type === "LINK")?.address ?? null;
          const addresses = aliases
            .filter((a) => a.type === "INET" || a.type === "INET6")
            .map((a) =>
              a.netmask != null ? `${a.address}/${a.netmask}` : a.address
            );

          handles.push(
            await ctx.writeResource("interface", `interface-${i.id}`, {
              id: i.id,
              name: i.name,
              type: i.type,
              linkState: i.state?.link_state ?? null,
              activeMedia: i.state?.active_media_type ?? null,
              mtu: i.state?.mtu ?? null,
              mac,
              addresses,
            }),
          );
        }

        ctx.logger?.info("Discovered {n} interfaces", { n: ifaces.length });
        return { dataHandles: handles };
      },
    },
  },
};
