# Crossflight Demo

Demonstrates [Crossflight](https://github.com/gkoos/crossflight), a cross-process cache stampede protection library, with a realistic infrastructure.

## Prerequisites

- [Docker](https://www.docker.com/) with [Compose v2](https://docs.docker.com/compose/) (the `docker compose` plugin, not the legacy `docker-compose`)
- [Node.js](https://nodejs.org/) 22.6+ — `npm run load` runs the CLI's TypeScript straight from source, which needs `node --experimental-strip-types`
- Ports 3000 (nginx), 3001 (upstream) and 6379 (Redis) free on the host

## Infrastructure

| Service | Role |
| --- | --- |
| `upstream` | Slow product API — 500ms artificial delay per request. `GET /product/:id` is the only counted endpoint; `/healthz` and `/stats` are free |
| `redis` | Shared Redis: coordinator leases and the cache-manager store, in separate key namespaces |
| `api_1`, `api_2`, `api_3` | Express API servers that coalesce misses with Crossflight; each serves its own counters on `GET /stats` |
| `nginx` | Round-robin across the three API instances on port 3000, plus `/instances` and `/instances/<name>/` for reading one instance's counters |

![Crossflight demo infrastructure diagram](assets/infrastructure-diagram.svg)

## How it works

Twenty requests hit the same product key at once, so nginx spreads them across all three API instances. Without coordination each would call the upstream for the same value; Crossflight lets one of them acquire ownership and run the loader while the others wait for its result.

The cache is [cache-manager](https://github.com/node-cache-manager/node-cache-manager) with `cache-manager-ioredis-yet` as the Redis store; the coordinator uses a second Redis connection and key namespace.

## Running

```sh
npm install                    # project dependencies
npm run up                     # build and start the stack, logs in the foreground

# in another terminal: 20 concurrent requests through nginx
CONCURRENCY=20 PRODUCT_ID=42 npm run load

npm run logs                   # follow every service
npm run logs:coordination      # only the api instances and the upstream
npm run logs:compact           # the same four services without compose's line prefix

npm run down                   # stop and clean up containers
```

On Windows (PowerShell):

```powershell
$env:CONCURRENCY=20; $env:PRODUCT_ID=42; npm run load
```

Two more ways to run the same load:

```sh
ROUNDS=2 npm run load         # round 1 cold, round 2 against a warm cache
NO_COALESCING=1 npm run load  # control run: the same stack with Crossflight skipped
```

## Example output

```
Crossflight load demo
  API:         http://localhost:3000 (nginx)
  Upstream:    http://localhost:3001 (500ms per call)
  Instances:   api_1, api_2, api_3
  Key:         product:42
  Concurrency: 20
  Rounds:      2

─── Round 1 · 20 simultaneous requests for product:42 ───

  Responses
    20/20 succeeded in 569ms
    served by api_1 7 · api_2 6 · api_3 7
    1 response ran the loader (api_2, 536ms) — the other 19 reused its result
    every response carries upstream call id #1, fetched by api_2

  Upstream (its own counter for this product)
    1 call, counter 0 → 1

  Per instance (its own counters for product:42)
    api_1  7 requests · 1 flight waited 541ms for another instance · 6 joined an in-process flight
    api_2  6 requests · 1 flight acquired the lease, its loader took 536ms · 5 joined an in-process flight
    api_3  7 requests · 1 flight waited 541ms for another instance · 6 joined an in-process flight
    20 requests accounted for: 3 flights + 17 joined in-process + 0 straight cache hits ✔
    of the 3 flights: 1 acquired the lease, 1 ran a loader, 2 waited for another instance

  Checks
    ✔ one loader execution (api_2, 536ms) served all 20 responses
    ✔ the upstream served 1 call, counted independently and matching 1 loader execution
    ✔ one upstream call id (#1) across every response — they all reused one value

  Sample response
    {
      "instance": "api_3",
      "ranLoader": false,
      "product": {
        "id": "42",
        "name": "Product 42",
        "price": "419.58",
        "fetchedAt": "2026-09-28T18:24:12.680Z",
        "upstreamCallId": 1,
        "fetchedBy": "api_2"
      }
    }

─── Round 2 · 20 simultaneous requests for product:42 ───

  Responses
    20/20 succeeded in 16ms
    served by api_1 6 · api_2 7 · api_3 7
    no response ran the loader — product:42 was already cached
    every response carries upstream call id #1, fetched by api_2

  Upstream (its own counter for this product)
    0 calls, counter 1 → 1

  Per instance (its own counters for product:42)
    api_1  6 requests · 2 joined an in-process flight · 4 flights read the cache without waiting
    api_2  7 requests · 7 flights read the cache without waiting
    api_3  7 requests · 1 joined an in-process flight · 6 flights read the cache without waiting
    20 requests accounted for: 0 flights + 3 joined in-process + 17 straight cache hits ✔

  Checks
    ✔ no loader ran: product:42 was still cached, so nothing had to be fetched
    ✔ the upstream served no calls at all: the warm cache did the work
    ✔ one upstream call id (#1) across every response — they all reused one value

Done.
```

All 20 responses of round 1 carry `upstreamCallId: 1` — the single call `api_2`'s loader made — so every client got the same value from one execution; round 2 runs no loader and makes no upstream call.

## What the demo measures

Each round is reported from three independent observers, and a ✔ appears only where they agree:

| Observer | What it reports |
| --- | --- |
| the responses | which request ran the loader (`ranLoader`), and the `upstreamCallId` / `fetchedBy` every payload carries |
| the upstream service | how many product calls it served, from its own counter read before and after the round (`GET /stats`) |
| each api instance | flights opened, owned and waited, requests shared in-process, loader executions, counted from Crossflight's events |

Nothing is inferred from response times: the waits are the `waitedMs` values Crossflight reports for the flight that waited, and the per-instance numbers are counted where the events happen.

### How the numbers add up

- **Every request is accounted for.** A request opens a flight or joins one already running in the same process, so `requests = flights + in-process shares` holds per instance; a flight that finds the value cached is reported as a hit.
- **`upstream calls == loader executions` is the check that matters.** The upstream counter knows nothing about Crossflight, so it would report two calls if two instances had ever run a loader.
- **One call id across every response** proves the payloads came from one execution of the loader rather than from several identical ones.
- **The split across instances is uneven, and that is fine.** nginx round-robins per worker process and the image starts one worker per CPU, so 20 requests land as something like `7 · 6 · 7`. Uneven routing only changes which instance waits: the extra requests join the flight already running in that process.
- **The control run is the baseline.** `NO_COALESCING=1` sends the same 20 requests through the same stack with `crossflight.wrap()` skipped: 20 loader executions, 20 upstream calls, 20 different call ids — the stampede the library prevents.

## Following the coordination in the api logs

Every Crossflight event gets one line, so `npm run logs` narrates the round top to bottom. nginx's access log is off, so once the startup banners are past the stream is the api instances and the upstream:

```
[api:api_2] CACHE MISS key=product:42 — nothing cached, opening a flight
[api:api_2] OWNER      key=product:42 — acquired the lease, running the loader
[api:api_1] CACHE MISS key=product:42 — nothing cached, opening a flight
[api:api_1] WAITING    key=product:42 — another instance owns the flight
[api:api_1] SHARED     key=product:42 — joining the flight already open in this process
[api:api_2] SHARED     key=product:42 — joining the flight already open in this process
[api:api_3] CACHE MISS key=product:42 — nothing cached, opening a flight
[api:api_3] WAITING    key=product:42 — another instance owns the flight
[api:api_2] COMPLETED  key=product:42 — flight finished in 549ms
[api:api_1] CACHE HIT  key=product:42 — another instance filled it after 540ms
[api:api_3] CACHE HIT  key=product:42 — another instance filled it after 542ms
[api:api_1] CACHE HIT  key=product:42 — served from the cache
```

`npm run logs` starts with the last 50 lines of each service, enough to see the round that just finished. `npm run logs -- --tail all` follows everything since the containers started, and `npm run logs -- api_2` follows one service.

Since every line names its instance (`[api:api_1]`), `npm run logs:compact` drops compose's service-name prefix: nothing is lost, and the longest line of a round — the `SHARED` line, 101 characters with the prefix — loses the 14 characters that can land it exactly on the last column of the terminal window, where some terminals render the following event on the same line. That is a rendering artifact, not log corruption: the log keeps one line per event, and `npm run logs > round.txt` shows them all apart.

The tag is the Crossflight event behind the line:

| Log tag | Event | Meaning |
| --- | --- | --- |
| `CACHE MISS` | `miss` | nothing cached here, this request opens a flight |
| `SHARED` | `local_join` | another request in this process is already handling the same key |
| `WAITING` | `distributed_join` | another instance holds the lease, this flight waits for it |
| `OWNER` | `ownership_acquired` | this flight got the lease and runs its loader |
| `CACHE HIT` | `hit` | value served from the cache, with `waitedMs` when it first had to wait |
| `COMPLETED` | `completed` | flight finished, the value is published and the lease released |
| `FAILED` | `failed` | the flight ended in an error |
| `FALLBACK` | `fallback` | coordination failed in `fail-open` mode, so the loader ran anyway |
| `GAVE UP` | `wait_exhausted` | the retry budget ran out while another instance kept the lease |
| `CANCELLED` | `cancelled` | a caller's own timeout or signal ended its wait |
| `LEASE LOST` | `renewal_failed` | the lease could not be renewed, so ownership is gone |

## Environment variables

### `api_1` / `api_2` / `api_3`

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `UPSTREAM_URL` | `http://upstream:3001` | Upstream product API |
| `PORT` | `3000` | HTTP port (internal) |
| `TTL_MS` | `10000` | Cache TTL in ms |
| `INSTANCE_ID` | set per service | Identifier shown in logs and responses |

Each instance also serves `GET /stats`, and handles a request without Crossflight when it carries the `x-no-coalescing: 1` header — that is how the control run works.

### `upstream`

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `DELAY_MS` | `500` | Artificial response delay |

`GET /stats` returns `{ total, byProduct, delayMs }`. The compose healthcheck calls `GET /healthz`, which never touches the product counter.

### `load` (CLI)

| Variable | Default | Description |
| --- | --- | --- |
| `API_URL` | `http://localhost:3000` | API base URL (nginx) |
| `UPSTREAM_URL` | `http://localhost:3001` | Upstream base URL, for its call counter |
| `PRODUCT_ID` | `42` | Product ID to request |
| `CONCURRENCY` | `20` | Concurrent requests per round |
| `ROUNDS` | `1` | Number of rounds to run |
| `NO_COALESCING` | unset | `1` bypasses Crossflight for the whole run |

If `UPSTREAM_URL` is unreachable the report says so and checks what it can; without an `/instances` index the per-instance block is skipped.

## Notes on the stack

- **Container names are resolved per request** (`resolver 127.0.0.11` plus `resolve` in the `api_pool` upstream), so rebuilding images while the stack is running does not leave nginx proxying to addresses that no longer exist.
- **`/stats` is read-only unless you ask for a reset.** `GET /stats?reset=1` clears the counters after reading them, so a round can be reported from zero; a plain read changes nothing.
- **The services are TypeScript with no build step.** `api/src`, `upstream/src` and `load/src` run straight from source: the containers start `node --experimental-strip-types`, and `npm run typecheck` checks all three under `strict` with `erasableSyntaxOnly`, so syntax Node cannot strip is a type error here.
- **nginx's access log is off**, because a round's worth of proxied requests would bury the api lines in `npm run logs`. Put it back inside the `server` block in `nginx/nginx.conf` with `access_log /dev/stdout;` — the format the image defines is `main`.
