# Robinhood Chain Trending Bot v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Telegram trending-channel bot for Robinhood Chain (EVM, chain 4663) memecoins: discover trending tokens via GeckoTerminal, enrich with an on-chain security scan + RPC edge, and post rich cards (with live-edit + up-Nx / dump follow-ups) reusing the Solana bot's Telegram layer.

**Architecture:** Single long-running Node/tsx process. Discovery = GeckoTerminal `robinhood` trending/new pools + an EVM WS listener for brand-new Uniswap pairs. A trending gate decides what posts; enrichment runs GeckoTerminal + our own on-chain honeypot/tax/renounce/LP/top-holder scan + fresh RPC reads. Cards, live-editing, and follow-ups are copied from the Solana `telebot` repo and re-bodied for EVM. SQLite holds seen/posted/follow-up state.

**Tech Stack:** Node ≥ 20, TypeScript via `tsx` (no build step), `ws`, `better-sqlite3`, `dotenv`, `vitest`. Global `fetch`. EVM calls hand-rolled (no heavy web3 dep) against an EVM HTTP+WS RPC (QuickNode or Alchemy for chain 4663).

**Spec:** `docs/superpowers/specs/2026-07-13-robinhood-trending-v1-design.md` (authoritative).
**Reuse source:** the Solana repo at `d:\Trenches` (a.k.a. `telebot`) — several files are copied verbatim and adapted.

## Global Constraints

- Node ≥ 20 (global fetch, `AbortSignal.timeout`). Windows dev host; PowerShell `;` chaining, Bash tool for POSIX. ESM (`"type": "module"`), `moduleResolution: "Bundler"`, imports WITHOUT file extensions.
- Runtime deps limited to: `ws`, `better-sqlite3`, `dotenv`. Dev deps: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/ws`, `@types/better-sqlite3`. NO web3/ethers — hand-roll the handful of EVM calls.
- All thresholds in `config.json`; secrets only from `.env`. Never commit `.env` (gitignore it).
- Chain: Robinhood Chain, EVM chain id **4663**, WETH-quoted Uniswap pools. GeckoTerminal network slug **`robinhood`** (verified).
- Every external call is timeout-bounded and degrades to the literal `'unknown'` / skip — never crash. A security field that can't be determined never upgrades the verdict toward "safe".
- Tests must not hit the network: inject `fetchFn` / RPC stubs; DB tests use `new Db(':memory:')`.
- Run tests with `npx vitest run <file>`. Commit after every task with its stated message.

---

### Task 0: Verification spike (throwaway) — lock the two remaining unknowns

**Files:** Create `spike/verify.mjs` (deleted at task end; NOT committed to src).

**Interfaces:** Produces confirmed constants for later tasks: `ROUTER_ADDRESS`, `WETH_ADDRESS`, `PAIR_CREATED_TOPIC0`, and a proven `eth_call` sell-sim shape. These get pasted into Task 5's `constants`.

- [ ] **Step 1: Resolve router/WETH from a live pair.** Using the RH_RPC_URL, take a live GeckoTerminal `robinhood` trending pool's pool address, `eth_getLogs`/`eth_call` the pair for `token0()`/`token1()` (identify WETH), and read a recent swap tx's `to` (the router). Record `WETH_ADDRESS`, `ROUTER_ADDRESS`.
- [ ] **Step 2: Get `PairCreated` topic0.** `keccak256("PairCreated(address,address,address,uint256)")` = `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0 ...` (compute/verify the full 32-byte topic against a real pair-creation log from the factory). Record `PAIR_CREATED_TOPIC0` and the factory address.
- [ ] **Step 3: Prove the sell-sim.** Pick a known-good token + a holder address (from a Transfer log). `eth_call` the router `swapExactTokensForETHSupportingFeeOnTransferTokens` (or `getAmountsOut` + a `from`-overridden `swapExactTokensForETH`) impersonating the holder; confirm it returns success + an output amount for a sellable token, and reverts for an unsellable one. Record the exact call encoding that works on this RPC.
- [ ] **Step 4: Write findings into the plan/spec** (update Task 5's constants block below with the real hex values), then delete `spike/`.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "chore: scaffold + verified RH chain constants (router/WETH/topic/sell-sim)"` (commit the scaffold from Task 1 together once it exists; if running Task 0 first, just record findings and let Task 1 make the first commit).

---

### Task 1: Project scaffold + config loader

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `config.json`, `src/types.ts`, `src/config.ts`; Test `tests/config.test.ts`.

**Interfaces:** Produces `loadConfig()`, `loadSecrets()`, types `AppConfig`, `TrendingConfig`, `SecurityConfig`, `FollowUpConfig`, `Secrets`, and the core `TokenCard` type consumed everywhere.

- [ ] **Step 1: `npm init -y`; install deps**
```powershell
npm install ws better-sqlite3 dotenv
npm install -D typescript tsx vitest @types/node @types/ws @types/better-sqlite3
```
- [ ] **Step 2: package.json scripts / tsconfig / .gitignore / .env.example** (mirror the Solana repo exactly)
```jsonc
// package.json (merge): "type":"module", scripts: { "start":"tsx src/index.ts","dry":"tsx src/index.ts --dry","test":"vitest run","typecheck":"tsc --noEmit" }
```
`tsconfig.json`: target ES2022, module ESNext, moduleResolution Bundler, strict, noEmit, `include:["src","tests"]`.
`.gitignore`: `node_modules/`\n`.env`\n`data/`\n`logs/`\n`spike/`.
`.env.example`:
```
RH_RPC_URL=https://your-endpoint.robinhood-mainnet.quiknode.pro/your-key/
RH_WS_URL=wss://your-endpoint.robinhood-mainnet.quiknode.pro/your-key/
GECKOTERMINAL_API_KEY=
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
```
- [ ] **Step 3: `config.json`** with defaults from the spec:
```json
{
  "trending": { "minLiquidityUsd": 5000, "minVolume1hUsd": 10000, "minBuyers1h": 30, "pollSeconds": 45, "milestones": [2,5,10,25,50,100], "dumpDrawdownPct": 50 },
  "security": { "sellTaxDangerPct": 30, "sellTaxWarnPct": 10, "topHolderWarnPct": 25 },
  "followUp": { "windowMinutes": 120, "liveEditSec": 45 },
  "buttons": { "chart": true, "scan": true, "trade": true }
}
```
- [ ] **Step 4: `src/types.ts`** — `TokenCard` (all metric fields `number | 'unknown'` where on-chain), `PoolActivity { address, symbol, name, liquidityUsd, volume1hUsd, buyers1h, priceUsd, fdvUsd, poolAddress, createdAt }`, `Security` (see Task 6).
- [ ] **Step 5–8: TDD `loadConfig`/`loadSecrets`** exactly like the Solana repo's `tests/config.test.ts` + `src/config.ts` (validate every numeric field; `loadSecrets` names missing env vars; `GECKOTERMINAL_API_KEY` optional). Run failing → implement → pass → typecheck.
- [ ] **Step 9: Commit** — `git commit -m "feat: scaffold, types, config loader"`

---

### Task 2: GeckoTerminal source client

**Files:** Create `src/sources/geckoterminal.ts`; Test `tests/geckoterminal.test.ts`.

**Interfaces:**
- Consumes: `PoolActivity` from `types`.
- Produces: `parsePool(raw): PoolActivity | null` (pure; maps a GT pool object → activity); `class GeckoTerminal { trendingPools(): Promise<PoolActivity[]>; newPools(): Promise<PoolActivity[]> }` (network fixed to `robinhood`; injectable `fetchFn`; 5s timeout, one retry, 2s central min-gap rate-limit).

- [ ] **Step 1: Failing test** for `parsePool` against a captured GT pool fixture (fields verified live: `attributes.reserve_in_usd`, `attributes.volume_usd.h24`, `attributes.transactions.h1.buyers`, `attributes.fdv_usd`, `attributes.base_token_price_usd`, `attributes.name`, `attributes.pool_created_at`; base token address via `relationships.base_token.data.id` → split on `_`). Assert a bad/missing object → `null`.
- [ ] **Step 2: run → fail. Step 3: implement `parsePool` + the client** (URL `https://api.geckoterminal.com/api/v2/networks/robinhood/trending_pools` / `/new_pools`; `accept: application/json`; header `Authorization` only if key set). Step 4: pass. Step 5: commit `feat: geckoterminal source client`.

---

### Task 3: EVM chain client (WS pair listener + JSON-RPC + ABI-lite)

**Files:** Create `src/chain/abi.ts` (pure encoders/decoders), `src/chain/evm.ts`; Test `tests/abi.test.ts`.

**Interfaces:**
- Produces: `abi.ts` — `selector(sig): string` (first 4 bytes of keccak256; ship a tiny keccak256 or a precomputed map for the ~6 signatures used), `encodeCall(sig, args)`, `decodeAddress/decodeUint(hex)`, `padAddress`. `evm.ts` — `class Evm extends EventEmitter { connect(): void; call(to, data, from?): Promise<string>; getLogs(filter): Promise<Log[]>; close() }` emits `'pair' ({ token, pair })` from `PairCreated` logs; reconnect+backoff+120s watchdog (copy the pattern from the Solana `pumpportal.ts`).

- [ ] **Step 1: Failing tests for `abi.ts`** — known selectors (`owner()` = `0x8da5cb5b`, `balanceOf(address)` = `0x70a08231`, `token0()` = `0x0dfe1681`, `getReserves()` = `0x0902f1ac`), address padding, uint decode. Step 2: fail. Step 3: implement (precomputed selector map + minimal ABI encode/decode; include a small keccak256 only if computing `PairCreated` topic at runtime, else hard-code the Task-0 topic constant). Step 4: pass.
- [ ] **Step 5: Implement `evm.ts`** (no unit test — thin I/O, verified in the Task 10 smoke). WS `eth_subscribe` `["logs", { address: FACTORY, topics: [PAIR_CREATED_TOPIC0] }]`; on log, decode token0/token1 → emit non-WETH token + pair. `call` = `eth_call` POST. Step 6: typecheck. Step 7: commit `feat: evm chain client (ws pair listener, json-rpc, abi-lite)`.

---

### Task 4: Blockscout verified-contract check

**Files:** Create `src/checks/blockscout.ts`; Test `tests/blockscout.test.ts`.

**Interfaces:** Produces `isVerified(addr, fetchFn?): Promise<boolean | 'unknown'>` via the RH Chain Blockscout API (`/api/v2/smart-contracts/{addr}` → 200 = verified, 404 = not, error → 'unknown'). Base URL in config/constant.

- [ ] TDD: 200 → true, 404 → false, throw → 'unknown'. Commit `feat: blockscout verified-contract check`.

---

### Task 5: RH Chain constants (from Task 0)

**Files:** Create `src/chain/constants.ts`.

**Interfaces:** Produces `ROUTER_ADDRESS`, `WETH_ADDRESS`, `FACTORY_ADDRESS`, `PAIR_CREATED_TOPIC0`, `BLOCKSCOUT_BASE`, `CHAIN_ID = 4663`, `DEAD_ADDRESSES` (0x000…0, 0x…dead) — all filled with the **verified** hex from Task 0 (no placeholders; if Task 0 hasn't run, it MUST run first).

- [ ] Create the file with the real values; `git commit -m "feat: verified RH chain constants"`.

---

### Task 6: On-chain security scan (honeypot sim + tax + renounce + LP + top-holder)

**Files:** Create `src/checks/security.ts`; Test `tests/security.test.ts`.

**Interfaces:**
- Consumes: `Evm.call`, `constants`, `isVerified`.
- Produces: `interface Security { honeypot: boolean|'unknown'; buyTaxPct: number|'unknown'; sellTaxPct: number|'unknown'; ownerRenounced: boolean|'unknown'; lpBurnedOrLocked: boolean|'unknown'; verified: boolean|'unknown'; topHolderPct: number|'unknown'; verdict: 'safe'|'warn'|'danger'|'unknown' }`.
- `securityScan(deps, token, pool, cfg): Promise<Security>` where `deps = { call, isVerified }`. Each sub-check best-effort → 'unknown'; `verdict` computed by a pure `scoreSecurity(s, cfg)` also exported.

- [ ] **Step 1: Failing tests for `scoreSecurity`** (pure): honeypot true → 'danger'; sellTax > `sellTaxDangerPct` → 'danger'; LP not burned/locked → 'danger'; sellTax in warn band OR owner not renounced OR topHolder > warn → 'warn'; all clean → 'safe'; any critical field 'unknown' never yields 'safe' (→ 'warn' or 'unknown'). Step 2: fail. Step 3: implement `scoreSecurity`. Step 4: pass.
- [ ] **Step 5: Failing tests for `securityScan`** with a stub `call` mapping (owner() → dead addr; getReserves; the sell-sim call → success/revert hex). Assert honeypot/tax/renounce mapping and that a reverting sell-sim → `honeypot:true`. Step 6: fail. Step 7: implement (owner() renounce check vs DEAD_ADDRESSES; sell-sim via router `getAmountsOut` expected vs `eth_call` sell impersonating a holder → tax = 1 − actual/expected, honeypot = revert; LP burned = LP-token balance of DEAD ≥ ~99% or a known locker; topHolder via largest Transfer-derived balance or GT). Step 8: pass. Step 9: commit `feat: on-chain security scan`.

---

### Task 7: Trending gate + milestone tracker

**Files:** Create `src/pipeline/trending.ts`; Test `tests/trending.test.ts`.

**Interfaces:** Produces `trends(a: PoolActivity, cfg: TrendingConfig): boolean` (pure: `liquidityUsd ≥ min AND (volume1hUsd ≥ min OR buyers1h ≥ min)`); `class Tracker` mirroring the Solana `followups.ts` (posted-once dedupe by address; milestone crossings from a baseline price/MC; dump drawdown), driving off polled MC rather than a trade stream.

- [ ] TDD the gate (each boundary) + milestone crossings (fires 2X/5X once each on a big jump; dump on >drawdown). Reuse the Solana `followups.test.ts` shapes. Commit `feat: trending gate + milestone tracker`.

---

### Task 8: Copy + re-body the Telegram layer

**Files:** Copy from `d:\Trenches\src\telegram.ts` → `src/telegram.ts`; Test copy `tests/telegram.test.ts`.

**Interfaces:** Keep `send`/`editCaption`/`buildButtons`/`SendResult`/`Keyboard` **verbatim** (chain-agnostic). Replace `formatAlert`→`formatCard(c: TokenCard)` with the EVM card body from the spec (🛡 Security line, MC/ATH/Liq/Vol/fake-vol/Holders/Top-holder, 0x contract tap-copy). Buttons: Chart (GeckoTerminal pool URL), Scan (Blockscout token URL), Trade (RH Chain Uniswap URL) with `{CA}` substitution.

- [ ] **Step 1:** copy the file; delete Solana-specific `formatAlert`/`formatFollowUp` bodies. **Step 2:** TDD `formatCard` (all fields + unknowns + the three security tiers + live "Now" line). **Step 3:** TDD `formatFollowUp` up/dump with the EVM card. **Step 4:** keep the existing `send`/`editCaption` tests (they pass unchanged). Commit `feat: telegram layer (card, live-edit, buttons) for EVM`.

---

### Task 9: Copy DB + enrichment orchestrator

**Files:** Copy/adapt `d:\Trenches\src\db\index.ts` → `src/db/index.ts`; Create `src/pipeline/enrich.ts`; Tests `tests/db.test.ts`, `tests/enrich.test.ts`.

**Interfaces:** `Db` tables: `tokens(address PK, symbol, name, first_seen, outcome)`, `posts(address PK, message_id, posted_at, sponsored INTEGER DEFAULT 0)`; methods `recordSeen`, `alreadyPosted`, `recordPost`, `getPost`. `enrich(activity, deps): Promise<TokenCard>` runs GeckoTerminal token info + `securityScan` + a fresh reserve read in parallel, each degrading to 'unknown'.

- [ ] TDD DB round-trips + `enrich` composition (stub sources; assert unknowns propagate; assert `sponsored` column exists for v2). Commit `feat: db + enrichment orchestrator`.

---

### Task 10: Main wiring + live-card ticker + dry-run smoke

**Files:** Create `src/index.ts`, `src/logger.ts`; Test `tests/smoke` via `npm run dry`.

**Interfaces:** Wire: poll GeckoTerminal every `pollSeconds` + Evm `'pair'` events → dedupe → `trends()` → `enrich()` → `formatCard` → `send` → record post + start live-card ticker (edit every `liveEditSec`, poll MC from GT) + milestone/dump follow-ups. `--dry` prints cards to console. Copy the live-card + latency-log patterns from `d:\Trenches\src\index.ts`.

- [ ] **Step 1–4:** implement, `npm test` (all green), `npm run typecheck`. **Step 5 (needs `.env` with a real RH_RPC_URL + RH_WS_URL):** `npm run dry` ~3 min — expect `stream: connected`, GeckoTerminal trending pools fetched, at least one `[DRY CARD]` printed with populated Security, no uncaught exceptions. **Step 6:** commit `feat: main wiring, live cards, dry-run`.

---

### Task 11: README + push

**Files:** Create `README.md`.

- [ ] Non-dev setup: QuickNode Robinhood Chain endpoint (RPC + WS), new Telegram bot via @BotFather, a channel with the bot as admin (Post + Edit), the 5 `.env` values, `npm run dry` then `npm start`; a tuning table for `trending.*` and `security.*`; a disclaimer. Commit `docs: readme`; create the GitHub repo and `git push -u origin main`.

---

## Self-Review

- **Spec coverage:** discovery (T2/T3), trending gate (T7), on-chain security replacing GoPlus (T5/T6), GeckoTerminal data (T2/T9), reused Telegram/DB/followups (T8/T9/T7), card + live-edit + follow-ups (T8/T10), config/thresholds (T1), error-handling doctrine (every task's constraints), verification unknowns (T0) — all mapped. Paid placement correctly deferred (T9 leaves a `sponsored` column; no v2 code).
- **Placeholder scan:** the only intentionally-deferred values (router/WETH/topic hex) are produced by the T0 spike and written into T5 before any code depends on them — not placeholders, a sequenced dependency.
- **Type consistency:** `PoolActivity`, `TokenCard`, `Security`, `SendResult`/`Keyboard` names are stable across T1–T10.
