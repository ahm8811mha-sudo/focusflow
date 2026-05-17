# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

FocusFlow is a **pure-vanilla-JS automated trading PWA** (no build tools, no npm, no framework) that supports two markets: US equities via Alpaca and Saudi equities (Tadawul) via a configurable generic REST broker + Alpha Vantage for bar data. The UI is in Arabic (RTL, `dir="rtl"`).

## Running the App

There is no build step. Serve the repo root as a static site:

```bash
# Any static server works, e.g.:
python3 -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080` in a browser. The app requires valid API credentials entered in the Settings modal before the engine can start.

There are no tests and no linter configured.

## Architecture

The app uses **ES modules** (`type="module"` in `index.html`) and a lightweight **publish/subscribe EventBus** (`js/events.js`) as the backbone for inter-module communication. No state management library — modules communicate exclusively through `EventBus.emit()` / `EventBus.on()`.

### Module Responsibilities

| Module | Role |
|---|---|
| `js/app.js` | Entry point — calls `Config.load()`, `UI.init()`, auto-start logic, service worker registration |
| `js/config.js` | Singleton `Config` — reads/writes `localStorage` key `tradingConfig`; provides broker headers and `isConfigured()` checks |
| `js/engine.js` | Singleton `Engine` — owns scan loop (`setInterval`), EOD close timer, order execution, trade log |
| `js/strategy.js` | Pure `Strategy.analyze(symbol, bars)` — returns `{ signal, entry, tp, sl, reason, volatility }` |
| `js/indicators.js` | Pure indicator functions: `rsi`, `ema`, `emaHistory`, `macd`, `bollingerBands`, `atr`, `volumeRatio`, `sma`, `isSqueezing` |
| `js/risk.js` | Singleton `RiskManager` — position sizing, daily loss halt, max positions/trades guard |
| `js/news.js` | `NewsScanner` — fetches Alpaca news + Finnhub economic calendar; blocks trades on high-impact events |
| `js/ui.js` | Singleton `UI` — subscribes to all EventBus events, owns all DOM rendering |
| `js/broker/alpaca.js` | `AlpacaBroker` — WebSocket streaming (`wss://stream.data.alpaca.markets/v2/iex`), REST trading + data API |
| `js/broker/saudi.js` | `SaudiBroker` — generic REST broker (user-configured base URL) + Alpha Vantage polling fallback for bar data |

### Data Flow

```
AlpacaBroker (WebSocket bars)  ──onBar()──▶  Engine._onBar()  ──EventBus──▶  UI (price display)
SaudiBroker  (poll/30s bars)   ──onBar()──▶

Engine._scan() [every N sec]
  │─▶ RiskManager.canTrade()         ← guards max positions, daily loss, daily trade count
  │─▶ Strategy.analyze(sym, bars)    ← RSI + BB + MACD + ATR volatility + news filter
  │─▶ Engine._executeSignal()
        │─▶ RiskManager.positionSize(entry)
        └─▶ broker.placeBracketOrder()  ──EventBus('trade:placed')──▶ UI
```

### Strategy Logic (`js/strategy.js`)

Conservative mean-reversion scalper. Requires minimum 30 bars (oldest-first `{o,h,l,c,v,t}`):

1. **Volatility filter**: `ATR(14) / price > volatilityMax (default 0.5%)` → skip
2. **News filter**: high-impact news on symbol in last 30 min, or high-impact economic event within 30 min → skip
3. **BUY**: RSI < oversold (35) AND Bollinger `%B < 0.15` AND MACD histogram ≥ −0.01 or crossUp
4. **SELL**: RSI > overbought (65) AND Bollinger `%B > 0.85` AND MACD histogram ≤ 0.01 or crossDown — **Saudi is long-only; SELL signals are dropped for SA market**

### Broker Differences

| | US (Alpaca) | Saudi |
|---|---|---|
| Data | WebSocket stream (real-time bars) | Alpha Vantage polling every 30 s (`.SR` suffix for Tadawul symbols) |
| Orders | Bracket orders via Alpaca REST | Bracket orders forwarded to user-configured REST base URL |
| Short selling | Supported | **Not supported** — SELL signals skipped in engine |
| Market hours | Mon–Fri 09:30–16:00 ET | Sun–Thu 10:00–15:00 Riyadh time (UTC+3) |
| History preload | `getBars(sym, '1Min', 100)` | `getAlphaVantageBars(sym, '5min')` |

### Configuration (`js/config.js`)

All settings persist in `localStorage` under `tradingConfig`. Defaults live in `DEFAULTS` at the top of `config.js`. Percentage fields stored as decimals (e.g. `takeProfitPct: 0.003` = 0.3%) — the Settings UI multiplies/divides by 100 for display.

External API keys required:
- **Alpaca** (`alpacaKey`, `alpacaSecret`) — trading + news + WebSocket; paper vs live toggled via `alpacaMode`
- **Finnhub** (`finnhubKey`) — economic calendar (optional; free tier at finnhub.io)
- **Alpha Vantage** (`alphaVantageKey`) — Saudi market bar data (optional; free tier at alphavantage.co)
- **Saudi broker** (`saudiBaseUrl`, `saudiKey`, `saudiSecret`) — any Saudi retail broker with a REST API

### PWA / Service Worker

`service-worker.js` caches all static JS/CSS/HTML assets (cache name `autotrader-v1`). API calls to `alpaca.markets`, `finnhub.io`, and `alphavantage.co` are explicitly bypassed. **When adding a new JS file, add it to the `STATIC` array in `service-worker.js` and bump the cache name** to force clients to update.

## Key Conventions

- **EventBus is the only inter-module communication channel.** Modules must not import each other in ways that create circular dependencies — the EventBus breaks the cycle between Engine ↔ UI.
- **Indicators are pure functions** — no side effects, no imports. Keep them that way.
- **`Engine.broker` is a computed property** (`this.market === 'SA' ? SaudiBroker : AlpacaBroker`) — use `this.broker` inside Engine rather than importing brokers directly.
- **Bar objects** always use the normalized shape `{ t, o, h, l, c, v }` regardless of source.
- **Settings form fields** are prefixed `cfg-` in the HTML (e.g. `id="cfg-takeProfitPct"`); `UI._loadSettingsForm()` and `UI._saveSettings()` iterate a hardcoded field list — add new settings to both the `DEFAULTS` in `config.js` and the field lists in `ui.js`.
