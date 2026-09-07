# MT5 / cTrader News Trader

Telegram-controlled, multi-user news trading platform for MetaTrader 5.

The backend is built with NestJS/TypeScript and PostgreSQL. Trade timing and order submission run locally in an MQL5 Expert Advisor so Telegram and the backend are not in the critical execution path at news time.

## Current milestone

Implemented:

- NestJS application structure and environment validation;
- PostgreSQL domain model with users, per-user defaults, MT5 agents, accounts, economic events, trade jobs, execution reports and audit logs;
- Telegram `/start`, `/connect`, `/status`, `/settings` and `/news` flows;
- persistent Telegram trade-creation wizard for selecting an event, account, symbol, execution mode and SL/TP;
- one-time MT5 pairing with an opaque device token;
- agent authentication and heartbeat;
- MT5 economic-calendar synchronization with broker-server-time to UTC conversion;
- safe job polling and execution-report API;
- MARKET BUY/SELL execution in the MQL5 EA;
- STRADDLE/OCO execution: Buy Stop and Sell Stop at `T-armSeconds`, cancel the sibling after a fill, server-side expiry at `T+30` by default;
- preflight checks for the account, demo/real mode, connection, Algo Trading, tick freshness, spread, volume and `OrderCheck`;
- local write-ahead idempotency ledger before `OrderSend`;
- system-wide real-trading kill switch, disabled by default.
- cTrader Open API OAuth connection without collecting broker passwords;
- encrypted cTrader access/refresh tokens and automatic demo/live account discovery.
- cBot SaaS transport with one-time Telegram pairing, local scheduling, MARKET,
  OCO, MULTI and NEWS_REVERSAL execution, idempotent labels and execution reports.

Not yet production-ready:

- daily realized-loss calculation and enforcement;
- position time-stop and post-fill management;
- metrics, alerting, rate limiting and a full operator console;
- broker-by-broker demo certification.
- automatic subscription payment webhook.

## Requirements

- Node.js 22+
- PostgreSQL 17+
- Redis 7+ (reserved for queues/locks in the next milestone)
- MetaTrader 5 on Windows or a Windows VPS

## Local backend setup

You install dependencies manually:

```bash
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

Before starting, replace `ADMIN_API_KEY`, `AGENT_TOKEN_PEPPER` and `TELEGRAM_WEBHOOK_SECRET` in `.env` with separate long random values.

For local Telegram polling:

```dotenv
TELEGRAM_BOT_TOKEN=your_botfather_token
TELEGRAM_MODE=polling
```

For production:

```dotenv
TELEGRAM_MODE=webhook
PUBLIC_BASE_URL=https://your-domain.example
TELEGRAM_WEBHOOK_SECRET=your_random_webhook_secret
```

Health endpoints:

- `GET /api/health/live`
- `GET /api/health/ready`

## MT5 setup

1. Copy `mt5/Experts/NewsTraderAgent.mq5` into the terminal's `MQL5/Experts` directory.
2. Compile it in MetaEditor.
3. In MT5, add the backend origin to **Tools → Options → Expert Advisors → Allow WebRequest for listed URL**.
4. In Telegram, run `/connect` and copy the eight-character code.
5. Attach the EA to a chart and set `InpPairingCode` and `InpApiBaseUrl`.
6. Keep `InpAllowRealTrading=false` during demo validation.

The agent token and write-ahead ledger are stored in that terminal instance's `MQL5/Files` directory. Broker credentials never pass through Telegram or the backend.

After the agent synchronizes the calendar, `/news` displays upcoming high-importance events. The user can create a MARKET BUY/SELL or STRADDLE OCO task through the Telegram wizard. `/jobs` lists active tasks and can cancel them before the armed execution window.

## Safety defaults

- backend `ALLOW_REAL_TRADING=false`;
- per-user `realTradingEnabled=false`;
- EA `InpAllowRealTrading=false`;
- default demo volume `0.01` lot;
- default risk `0.25%`;
- maximum system risk `0.50%`;
- preparation window `10` seconds;
- OCO pending lifetime through `T+30` seconds;
- if either side of an OCO pair is rejected, the accepted sibling is removed;
- maximum lateness `1000` ms;
- one concurrent active news job;
- no automatic retries after the execution deadline.

All three real-trading switches must eventually be enabled explicitly. A successful `OrderSend` request still needs confirmation through its retcode and trade transaction.

The estimated monetary risk cap is optional per user and defaults to `OFF`. It can be toggled in Telegram `/settings`. Broker margin preflight, the per-user position limit, duplicate-execution protection and the global emergency stop remain mandatory even when the estimated risk cap is disabled.

## cBot SaaS connection

When a broker blocks Open API trading, use the included cBot connector. The
backend remains centralized on Linux; only the small connector runs inside the
user's cTrader account (including cTrader Cloud).

1. Deploy the backend and apply Prisma migrations.
2. Compile `ctrader/cbots/TradeTmConnector/TradeTmConnector.cs` in cTrader Algo.
3. Get a one-time code with `/connect_cbot`.
4. Start the cBot on the account's XAUUSD chart with the production backend URL,
   code and expected account number.
5. Verify `/status`, then create `/test` and select the `cBot` account.

See [the cBot setup guide](ctrader/cbots/TradeTmConnector/README_RU.md).

## Development checks

After installing dependencies:

```bash
npm run prisma:generate
npm run build
npm test
npm run lint
```

The MQL5 file must also be compiled in MetaEditor because the Node.js toolchain cannot validate MQL5 syntax.

See [docs/agent-protocol.md](docs/agent-protocol.md) for the current wire protocol and state machine.

## Production VPS

The production stack is defined in `docker-compose.production.yml` and includes the application, one-shot Prisma migrations, PostgreSQL, Redis and Caddy automatic HTTPS. Database and Redis ports are not published.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# Fill the domain, Telegram/cTrader credentials and newly generated secrets.
./scripts/production/deploy.sh
```

Follow the complete first-deploy, firewall, DNS, demo-certification, emergency-stop and backup procedure in [docs/VPS_DEPLOYMENT.md](docs/VPS_DEPLOYMENT.md). Keep `ALLOW_REAL_TRADING=false` during deployment and demo certification.

## cTrader Open API setup

This connector does not require MT5/cTrader terminals on the server. One backend can keep accounts for many users; cTrader requires separate shared WebSocket connections for demo and live execution.

1. Register an application in the [cTrader Open API portal](https://openapi.ctrader.com/).
2. Add the exact redirect URL `https://your-domain.example/api/v1/ctrader/oauth/callback` to the application.
3. Generate an encryption key once with `openssl rand -base64 32` and keep it outside source control.
4. Configure `.env`:

```dotenv
CTRADER_ENABLED=true
CTRADER_CLIENT_ID=your_client_id
CTRADER_CLIENT_SECRET=your_client_secret
CTRADER_REDIRECT_URI=https://your-domain.example/api/v1/ctrader/oauth/callback
CTRADER_TOKEN_ENCRYPTION_KEY=your_base64_32_byte_key
```

5. Apply the migration with `npm run prisma:deploy`, restart the backend, then use `/connect_ctrader` in Telegram.

The OAuth link is single-use and expires after 10 minutes. The authorization code is consumed immediately, tokens are encrypted with AES-256-GCM, and `/status` shows discovered cTrader demo/live accounts. MARKET, OCO and independent MULTI execution are supported. Keep `ALLOW_REAL_TRADING=false` until demo certification is complete.

### Execution safety and emergency stop

Production safety defaults are configured through `.env`:

```dotenv
TRADING_KILL_SWITCH=false
MAX_OPEN_POSITIONS_PER_USER=10
CTRADER_MARGIN_BUFFER_PERCENT=25
CTRADER_JOB_LEASE_SECONDS=45
```

Every cTrader job is claimed with a PostgreSQL lease, so multiple backend instances cannot submit it concurrently. Before submission the worker enforces the projected per-user position limit, configured risk ceiling where exact currency conversion is available, and cTrader's expected-margin estimate with the configured reserve. Unexpected WebSocket closures release the lease after a short backoff; the next worker reconnects, reconciles labelled orders/positions and continues without blindly resubmitting.

The database-backed emergency switch affects all backend instances. Requests require `x-admin-api-key`:

```bash
curl -X POST http://localhost:3000/api/v1/admin/safety/halt \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"operator emergency stop"}'

curl http://localhost:3000/api/v1/admin/safety \
  -H "x-admin-api-key: $ADMIN_API_KEY"

curl -X POST http://localhost:3000/api/v1/admin/safety/resume \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

Halting blocks new jobs and new cTrader submissions and cancels pending cTrader entries. Already open positions are deliberately left open with their broker-side SL/TP; the switch never closes market exposure unexpectedly. Setting `TRADING_KILL_SWITCH=true` is a stronger environment-level stop and cannot be resumed through the API.

### Local cTrader mock mode

While an Open API application is awaiting approval, enable the local simulator:

```dotenv
CTRADER_ENABLED=false
CTRADER_MOCK_MODE=true
```

Restart the backend, run `/connect_ctrader` to create an isolated mock demo account, then `/test`. Select the cTrader mock account and configure MARKET or STRADDLE as usual. After confirmation, choose `BUY fill`, `SELL fill`, `Timeout` or `Reject`. The engine arms the task at `T-armSeconds`, simulates submission and OCO sibling cancellation, then closes a filled mock position by Take Profit. `/mock_results` displays the generated execution reports.

Mock mode never connects to cTrader or a broker and never sends a real order. Disable it after Open API approval.

## Strategy V2: Probe Entry

The first non-news strategy is implemented for `XAUUSD` as a connector-independent state machine:

- H1 trend regime: EMA 50 versus EMA 200;
- M15 breakout of the previous 20 completed candles;
- ATR 14 volatility and abnormal-candle filter;
- one probe entry risking 0.10%;
- remaining 0.30% is added only after a held retest or 0.5 ATR favourable movement;
- 1.2 ATR stop, 3R target, three-bar confirmation deadline and four-bar cooldown;
- no averaging down, grid or martingale;
- spread limit and one active position per strategy configuration.

Telegram commands:

```text
/strategy_v2    configure and enable the strategy for a cTrader account
/strategy_demo  generate a deterministic mock trend, breakout, retest and TP scenario
```

For external candle ingestion, send an authenticated `POST /api/v1/strategy-v2/candles` request with `x-admin-api-key`. This currently creates simulated strategy positions only. A real cTrader order adapter, broker symbol metadata and historical/forward validation are required before live trading.

### Strategy V2 on an MT5 demo account

The MT5 agent can provide real broker candles and execute the strategy through the existing idempotent job protocol while cTrader approval is pending.

1. Compile the updated `NewsTraderAgent.mq5` (`0.3.0`) in MetaEditor.
2. Attach it to any chart on the already paired demo terminal.
3. Set:

```text
InpEnableStrategyV2 = true
InpStrategySymbol   = XAUUSD
InpAllowRealTrading = false
```

4. Restart the backend and EA, then run `/strategy_v2` in Telegram and enable the row labelled `MT5 <login>`.
5. Keep the terminal and Algo Trading enabled. The strategy checks only completed M15 candles, so it may legitimately wait many hours or days for a valid signal.

For this certification stage, PROBE and MAIN are separate market jobs of `0.01` lot each. They use the same strategy-derived risk distances, but the EA calculates each leg's actual SL/TP from its own fill price. Only demo accounts are accepted by both backend and EA. Do not enable this version on a real account.
