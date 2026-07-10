# @keeb/truenas

Manage a [TrueNAS SCALE](https://www.truenas.com/) host from
[swamp](https://swamp.club). This extension talks to the TrueNAS REST API v2.0
and turns the box into **decomposed, typed swamp resources** — one queryable
data instance per pool, dataset, snapshot, service, alert, and share — rather
than one opaque blob you have to post-process. Every domain is its own model, so
you can sweep state with a single `discover` and then ask precise questions with
CEL (`swamp data query`).

It is built and tested against TrueNAS **SCALE 22.12 (Bluefin)**, whose REST API
v2.0 is first-class. It should work on newer releases that still expose REST v2.0.

## Models

| Type                       | Resources (typed)                                       | Key methods                                                                                                             |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@keeb/truenas/system`     | `info`, `alert`, `service`                              | `discover`, `service_start`, `service_stop`, `service_restart`                                                          |
| `@keeb/truenas/storage`    | `pool`, `dataset`, `snapshot`, `disk`                   | `discover`, `discover_disks`, `discover_snapshots`, `create_dataset`, `delete_dataset`, `create_snapshot`, `delete_snapshot` |
| `@keeb/truenas/sharing`    | `smb`, `nfs`, `iscsiTarget`                             | `discover`, `smb_set_enabled`, `nfs_set_enabled`                                                                        |
| `@keeb/truenas/accounts`   | `user`, `group`                                         | `discover`                                                                                                              |
| `@keeb/truenas/network`    | `interface`                                             | `discover`                                                                                                              |
| `@keeb/truenas/apps`       | `app`                                                   | `discover`, `set_replicas`                                                                                              |
| `@keeb/truenas/protection` | `snapshotTask`, `replication`, `cloudSync`, `rsyncTask` | `discover`                                                                                                              |

The `storage` `pool` resource carries redundancy (vdev layout, fault tolerance)
and last-scrub state; `discover_disks` adds one `disk` resource per drive with
SMART status and temperature.

## Setup

Create a TrueNAS API key (Settings → API Keys) with a wildcard allowlist, store
it in a vault, and wire a model definition to it. The API key is resolved fresh
from the vault on every run and redacted from logs.

```sh
# 1. Store the API key in a vault (piped — never echoed)
swamp vault create local_encryption truenas
echo "1-XXXX...your-key..." | swamp vault put truenas api_key

# 2. Create a model wired to the vault
swamp model create @keeb/truenas/storage tn-storage \
  --global-arg 'baseUrl=http://truenas.lan/api/v2.0' \
  --global-arg 'apiKey=${{ vault.get(truenas, api_key) }}'

# 3. Sweep state, then query it
swamp model method run tn-storage discover
```

## Querying (the point)

Because each object is its own typed resource, you query state at the source with
CEL instead of dumping and filtering JSON:

```sh
# Datasets using more than 1 TB
swamp data query 'modelName == "tn-storage" && specName == "dataset" && attributes.usedBytes > 1000000000000' \
  --select '{"id": attributes.id, "used": attributes.used}'

# Enabled NFS exports with no host/network allowlist (exposure audit)
swamp data query 'modelName == "tn-sharing" && specName == "nfs" && attributes.enabled == true && size(attributes.hosts) == 0 && size(attributes.networks) == 0'

# Services that are enabled but not running (drift)
swamp data query 'modelName == "tn-system" && specName == "service" && attributes.enable == true && attributes.state != "RUNNING"'
```

## How it works

All models share `lib/client.ts`, a thin `TrueNasClient` over `fetch` that
adds Bearer auth, JSON encoding, and error shaping (it surfaces the TrueNAS
middleware's own validation messages). Each model's `discover` fans out across
the relevant endpoints and writes one typed resource per object; size fields are
stored both as numeric `*Bytes` (for thresholds) and a human string (for
reports). Mutating storage methods verify the target's live state before acting.

**Transport / security note:** TrueNAS ships a self-signed `CN=localhost` cert,
so HTTPS from the Deno runtime fails hostname verification. On a trusted LAN the
models are typically pointed at the plain-HTTP endpoint (`http://host/api/v2.0`);
`baseUrl` is a per-model argument, so switch it to `https://` once you front the
box with a real certificate or reverse proxy.

## License

MIT — see LICENSE for details.
