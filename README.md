# dsafe-index-service

Watches [Safe](https://safe.global) deployments on Gnosis and publishes a
**signed owner→Safes index** to a Swarm feed, so the [dSAFE](https://github.com/flotob/dSAFE)
app can answer "which Safes does my wallet own?" without a centralized API.

The service layer of dSAFE — the last piece that would otherwise be a trusted
server. Mirrors the `radicle-index-service` / `freedom-adblock-service` pattern
already running on the Freedom Coolify stack.

## Trust model

*The index decides what you see; the chain decides what's true.* The manifest is
EIP-191-signed by a key clients pin. It can omit or lag, but the app verifies
the signature **and re-verifies each Safe's ownership on-chain when opened** — so
a bad index can only **withhold**, never **forge**.

## How it works

1. Scan `SafeSetup` events on Gnosis → discover Safes; read each one's
   **current** owners/threshold via Multicall3 (reflects later owner changes).
2. Build an owner→Safes manifest, EIP-191-sign it (`sig` over canonical JSON
   with `sig:""` — wire-compatible with the app's verifier).
3. Publish to a Swarm feed via `bee-js` (upload collection → point feed at it →
   stable feed-manifest reference). **Publish-on-change** (content hash) so an
   unchanged index doesn't churn the feed.

Clients pin the **signer address** + **feed manifest reference** and resolve
`bzz://<feedManifest>/manifest.json`.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `CHAIN_ID` | `100` | Gnosis |
| `GNOSIS_RPC` | public | Gnosis JSON-RPC |
| `BEE_URL` | `http://bee:1633` | shared bee node on the coolify network |
| `POSTAGE_BATCH_ID` | auto | **dedicated, MUTABLE** batch — set explicitly in prod |
| `FEED_SIGNER_KEY` | — | feed identity; **pinned by clients, needs no funds**; back up |
| `START_BLOCK` / `LOOKBACK_BLOCKS` / `WINDOW_BLOCKS` | `0` / `50000` / `9000` | scan range + eth_getLogs window |
| `INTERVAL_MINUTES` | `60` | daemon cycle |
| `OUT_DIR` / `STATE_FILE` | `/data/out` / `/data/state.json` | on the volume |

## Run

```sh
npm install
npm run dry      # scan + sign, no publish (prints a preview)
FEED_SIGNER_KEY=0x… BEE_URL=http://127.0.0.1:1633 npm run once   # one publish cycle
npm start        # daemon: re-publish on change every INTERVAL_MINUTES
```

Docker:

```sh
docker build -t dsafe-index-service .
docker run --rm -v dsafe-index-data:/data \
  -e FEED_SIGNER_KEY=0x… -e BEE_URL=http://bee:1633 -e POSTAGE_BATCH_ID=… \
  dsafe-index-service
```

## Deploy on Coolify (Freedom Hetzner stack)

Build pack **Dockerfile**, on the `coolify` network (reaches the shared `bee`
node). Background worker — no public port.

1. Buy a **dedicated, mutable, depth ≥ 20** postage batch on the bee node
   (bulk SOC writes overflow shallow buckets — see the swarmit-coolify notes):
   `curl -X POST -H "Immutable: false" "http://bee:1633/stamps/<amount>/20?label=dsafe-index"`
2. New app → this repo → set env vars (`FEED_SIGNER_KEY` secret,
   `POSTAGE_BATCH_ID`, `BEE_URL=http://bee:1633`, `INTERVAL_MINUTES`,
   `LOOKBACK_BLOCKS`). Add a `/data` volume for state.
3. Deploy. On first cycle it logs the **feed manifest** and **signer** — pin
   both in the dSAFE app (`VITE_SAFE_INDEX_FEED`, `VITE_SAFE_INDEX_SIGNER`).
4. Back up `FEED_SIGNER_KEY` in the password manager (clients pin it).

## Known limitation

The scan is stateless — it re-scans a `LOOKBACK_BLOCKS` window each cycle, so it
indexes recent Safes within that window, not all of Gnosis history. A
production-scale index should scan from a `START_BLOCK` forward once and persist
incrementally (state file already exists for publish-dedup; extend it to track
`lastScannedBlock`). Fine for a bounded/recent index today.
