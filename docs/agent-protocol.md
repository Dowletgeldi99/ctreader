# MT5 agent protocol v2

All backend routes use the global `/api` prefix.

## Pairing

`POST /api/v1/pairing/claim`

The EA exchanges an eight-character, single-use Telegram pairing code for an agent bearer token. The token is returned once and only its HMAC-SHA256 digest is stored by the backend.

## Authenticated endpoints

Every subsequent request includes:

```http
Authorization: Bearer mt5_...
```

Endpoints:

- `POST /api/v1/agent/heartbeat`
- `POST /api/v1/agent/economic-events/sync`
- `GET /api/v1/agent/jobs`
- `GET /api/v1/agent/jobs.mt5`
- `POST /api/v1/agent/jobs/:jobId/reports`
- `POST /api/v1/agent/strategy-v2/candles/batch`

The JSON job endpoint is intended for diagnostics and future agents. `jobs.mt5` is a compact, line-oriented representation that avoids embedding a large JSON parser in the EA.

## Time contract

PostgreSQL and the public API store UTC timestamps. The MT5 calendar and local executor operate in the broker's trade-server clock.

The heartbeat sends `serverUtcOffsetSeconds`. Calendar occurrences are sent as `scheduledAtServerUnix`; the backend subtracts the offset before storage. The line protocol adds the same offset when delivering a UTC job back to the EA.

The EA refreshes the broker-time second boundary with a millisecond timer. This improves local dispatch timing but does not guarantee broker fill time or fill price.

## Job record

The first line is:

```text
NEWSBOT/2|<backend UTC time>
```

Each following line contains:

```text
JOB2|id|idempotencyKey|accountLogin|accountServer|environment|symbol|direction|executionMode|riskMode|fixedLot|riskPercent|slPoints|tpPoints|deviationPoints|maxSpreadPoints|armSeconds|maxLatenessMs|entryDistancePoints|pendingExpirySeconds|executeAtServerUnix|expiresAtServerUnix|version
```

Cancellation records use:

```text
CANCEL|jobId|version|cancelledAtUtc
```

The backend rejects user cancellation after the job enters its armed window. This avoids a race where the order is already being submitted while the Telegram cancellation is in flight.

Wire values must not contain `|`, CR or LF. The backend sanitizes the only free broker field currently included in this format.

## State machine

```text
SCHEDULED → SYNCED → ARMED → SUBMITTED → FILLED → MANAGED → CLOSED
                         ↘ REJECTED
              ↘ MISSED / CANCELLED / EXPIRED
```

Forward recovery transitions are accepted when an earlier HTTP report was lost. Terminal states cannot regress.

Every report has a unique `reportKey`. Every trade job has a unique `idempotencyKey`. Immediately before `OrderSend`, the EA flushes the job ID into its local write-ahead ledger. On restart, it reconciles the MT5 history by the job-derived magic number instead of submitting blindly again.

For `STRADDLE`, the EA places both pending orders when the arm window begins. Both orders use broker-side `ORDER_TIME_SPECIFIED`; `expiresAtServerUnix` is normally event time plus `pendingExpirySeconds`. The first entry deal triggers immediate removal of the sibling order. An incomplete pair is removed fail-closed. If both orders fill before cancellation completes, the EA reports the race and, on a hedging account, attempts to close the second position immediately. On a netting account it reports the resulting account state without pretending the legs are independent positions.

## Fail-closed rules

The EA does not submit an order when:

- the connected account or server differs from the job;
- the job targets a real account and the local real-trading switch is off;
- the terminal is disconnected or Algo Trading is disabled;
- the tick is missing or stale;
- spread is above the job limit;
- calculated volume is invalid;
- `OrderCheck` fails;
- the idempotency ledger cannot be persisted;
- the configured execution deadline has passed.

## Strategy V2 candle feed

When `InpEnableStrategyV2=true`, the EA sends only completed XAUUSD candles. On startup it sends 220 H1 and 40 M15 candles; afterwards it sends a batch only when a new H1 or M15 candle closes. Broker-server candle timestamps are converted to UTC.

```json
{
  "candles": [{
    "symbol": "XAUUSD",
    "timeframe": "M15",
    "openTime": "2026-08-25T12:00:00Z",
    "open": 2500.1,
    "high": 2501.2,
    "low": 2499.8,
    "close": 2500.9,
    "spreadPoints": 25,
    "point": 0.01
  }]
}
```

The endpoint accepts at most 300 candles and only from the authenticated agent's demo account. Historical candles seed EMA/ATR calculations; only the newest completed M15 candle in each batch may advance the strategy state machine. Strategy orders are emitted through the existing `JOB2` protocol with fixed `0.01` lot for each of the PROBE and MAIN legs.
