# UNS Hot Rolling Data Catalog demo

A public TypeScript microservice created with `@uns-kit/cli`. It registers one
Data Catalog offer with three GET operations: a JSON preview, a CSV download,
and a Parquet download. All three read the same **single attribute** from the
fictional [`rtt-demo-app`](https://github.com/uns-openhub/rtt-demo-app):

`forge-group/novasteel/hot-rolling/hrm-pusher-furnace/equipment/zone-1/temperature`

Each row contains `time`, `temperatureC`, and `uom`. The JSON preview returns at
most 500 rows and an explicit `hasMore` flag. File exports do not silently stop
at the history API's 2,000-row per-request limit: they split full time windows
and write CSV/Parquet incrementally to a unique temporary directory. The file
is deleted when the response stream closes. A seven-day query window, 128 MiB
file limit, and two concurrent file preparations bound demo resource use;
exceeding a limit returns an error rather than an incomplete file.

The source namespace is fictional. No customer names, credentials, or production
data are included.

## Prerequisites

- Node.js 22+ and pnpm for direct development, or a compatible UNS OpenHub 2.x
  controller for RTT installation.
- `rtt-demo-app`, `uns-archiver`, and `uns-api-global` running so the selected
  temperature topic is published and its history can be queried.
- A logged-in caller with access to the source topic. The demo forwards that
  caller's bearer token to `UnsClient.history`; it does not use its own machine
  token to widen the caller's read access.
- The demo simulator's configured `demo.mes / novasteel.mes / equipment.code`
  provider identity namespace reviewed as **active** in _Asset identity →
  External identifiers → Approve source_. Approving a namespace is an operator
  trust decision; this project does not approve it automatically.

## Start directly on a development host

```sh
pnpm install --frozen-lockfile
cp config-development-host.json config.json
cp .env.example .env
pnpm run dev
```

The `.env` example contains only controller routing metadata. A directly
started service must provide its own reachable `UNS_CONTROLLER_NAME` and
`UNS_CONTROLLER_PUBLIC_BASE` values for retained API route discovery. The
`config.json` and `.env` files are ignored by Git. For a controller-managed RTT
instance, use `config-development-podman.json` or `config-production.json`;
the controller supplies its own routing identity.

The service requires `uns.jwksWellKnownUrl` and never falls back to a static JWT
secret. Its only data source is the simulator's zone 1 temperature attribute.

## Try it in Data Catalog

Open _Data Catalog → Novasteel furnace zone 1 temperature_. All three
operations take required `from` and `to` ISO 8601 timestamps with a timezone.
For example:

```text
from=2026-09-23T12:00:00Z
to=2026-09-23T13:00:00Z
```

The public routes are:

```text
GET /api/forge-group/novasteel/hot-rolling/hrm-pusher-furnace/dataset/zone-1-temperature/json
GET /api/forge-group/novasteel/hot-rolling/hrm-pusher-furnace/dataset/zone-1-temperature/csv
GET /api/forge-group/novasteel/hot-rolling/hrm-pusher-furnace/dataset/zone-1-temperature/parquet
```

The JSON response has `{ count, hasMore, data }`; downloaded files carry a
`Content-Disposition` filename. CSV and Parquet contain the same typed rows.
No rows produce an empty CSV or Parquet file. If the history API is unavailable
or its per-topic query reports an error, the export fails rather than producing
a partial download.

## Build and verify

```sh
pnpm run verify
```

The tests cover range validation, complete export across multiple limited
history requests, and actual CSV/Parquet file generation. The public repository
contains no local configuration or credentials.

## How the official add-on catalog is published

A public GitHub repository by itself does not enter the official signed add-on
catalog. `uns-datahub-tools/tools/internal/addoncatalog/catalog.go` has a
code-reviewed allowlist. After a versioned, non-draft GitHub Release is
published and this repository has been added to that allowlist, the catalog
operator builds and reviews the result with `make catalog-build`, then signs
and publishes it with `make catalog-publish`. The website serves the signed
files but does not generate or sign them. The private tools repository's
`docs/public-addon-catalog.md` contains the full release procedure.
