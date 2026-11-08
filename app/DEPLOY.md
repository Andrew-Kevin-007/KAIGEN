# Deploying the KAIGEN app

Next.js 16 app. Run everything below from `app/`. Nothing here needs a key, a fund or a secret in a file.

## One project, two layouts

The landing page and the app are one Next.js project and one deployment. `NEXT_PUBLIC_SITE_URL` and the site's `NEXT_PUBLIC_APP_URL` are gone: every link between them is internal.

| Route | Layout | What it is |
|---|---|---|
| `/` | `app/(landing)` (own root layout, `landing.css`, Family template look) | Landing page; Connect wallet goes to `/start` |
| `/start` | `app/(app)` | After connecting: find the vault (candidates from the connected account, or a typed name), then the read-only walkthrough |
| `/omens` | `app/(app)` | The era, omens, bounty and the recorded drill (was `/`) |
| `/vault`, `/vault?account=<id>`, `/vault/create`, `/bounty`, `/migrate` | `app/(app)` | As before; `/vault` reads `?account=` |

The two root layouts are two separate documents, so the landing's global stylesheet cannot reach app pages and the reverse. Going between them is a full page load (the wallet session is restored from the browser on each load). The landing's Family-derived files are listed in `ASSETS-TO-REPLACE.md`.

## What the app knows about the chain

The app reads one thing: which contracts it talks to. It never defaults to an address.
Unset, empty, `{}` or a file still full of `REPLACE-...` placeholders all mean **"not deployed yet"**, and every page that needs a contract says so (Era, Bounty, Vault lookup, Create vault).
A setting that is wrong (bad JSON, a bad account name, a mainnet account on a testnet build, an RPC that is not https) shows a red notice on every route, and `next build` stops on it.

## Environment variables

| Variable | Where | What |
|---|---|---|
| `NEXT_PUBLIC_DEPLOYMENTS` | build | The public part of `deployments.json`, as JSON text. If set, it wins over any file. On Vercel, paste the JSON. |
| `KAIGEN_DEPLOYMENTS` | build | Path (relative to `app/`) of a deployments file. Default: `../deployments.json` if it exists. A named file that is missing is an error. |
| `KAIGEN_FIRE_TESTS` | build | Folder of fire-test records. Default: `fire-tests/` beside the deployments file (`../fire-tests`). |
| `ONECLICK_JWT` | server | Optional 1Click token for the bounty top-up. Without it 1Click charges a 0.2% fee. Never in a file. |
| `ONECLICK_BASE_URL` | server | Optional 1Click API base. |
| `KIZASHI_CODE_HASH` | server | Code hash the deployed Kizashi must have. Top-ups stay off until it is set. |
| `TOPUP_ALLOW_TESTNET` | server | `1` lets top-up routes run on a testnet build. Default off. |
| `TRUSTED_PROXY_HOPS` | server | Proxies in front of the app, for the rate limiter. |
| `KAIGEN_CSP` | dev | `off` drops the strict policy to diagnose a blocked request. Development only. |

`NEXT_PUBLIC_VAULT_CREATE` is gone. Create vault is decided by the network alone (below).

## How `deployments.json` is read

`next.config.ts` calls `lib/deployments-file.ts` at build time and puts the result in `NEXT_PUBLIC_DEPLOYMENTS`. Order: the variable if set, else the `KAIGEN_DEPLOYMENTS` file, else `../deployments.json`.
Only these fields reach the browser bundle: `network`, `rpc`, `kizashi`, `mamoriReference`, `mamoriCodeHash`, `drill.kizashi`. Everything else in the file (init-file paths, the keeper's vault list, secondary RPCs, daily keys) stays out.
The newest usable `fire-tests/NNNN.json` is added as the recorded drill. `lib/deployments.ts` parses the result and never throws.
`deployments.example.json` at the repo root is the shape. Copied unchanged it reads as "not deployed yet".

A testnet file needs at least:

```json
{ "network": "testnet", "kizashi": "kizashi.<you>.testnet", "mamoriReference": "mamori.<you>.testnet" }
```

`network` must be `testnet` or `mainnet`; anything else reads as mainnet. Accounts must end in the network's suffix.

## Run it on testnet

```
set KAIGEN_DEPLOYMENTS=../deployments.json     (or set NEXT_PUBLIC_DEPLOYMENTS to the JSON)
npm install
npm run dev          # http://localhost:3000
```

A testnet build shows a "Testnet" banner on every route. The RPC's chain id is checked before a vault is read; a testnet node is never shown as production.
Production build: `npm run build` then `npm start`. Checks: `npm run typecheck` and `npm test`.

## Create vault

On for testnet, off for mainnet whatever else is set (`createVaultGuard` in `lib/vault-create.ts`, checked when the page renders and again before each step). The mainnet page says why: gates G1 and G3 have to pass there first.
It needs a wallet and test NEAR. It creates the vault account and leaves it with only the admin key; it does not deploy Mamori.

## What is not done

- No Kizashi, Mamori reference or drill is deployed by this repo; until `deployments.json` names real accounts every page says "not deployed yet".
- Create vault has not been run against a real chain or wallet.
- Putting the Mamori code on a created vault (copy from `mamoriReference`, check `mamoriCodeHash`) is not built.
- Bounty top-ups run on mainnet only, unless `TOPUP_ALLOW_TESTNET=1`, and need `KIZASHI_CODE_HASH`.
- Mainnet: nothing is switched on. The repo README still describes the removed `NEXT_PUBLIC_VAULT_CREATE` flag (outside `app/`, not edited here).
