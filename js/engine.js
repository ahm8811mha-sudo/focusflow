// ─── Trading Engine ───────────────────────────────────────────────────────────
import { Config }        from './config.js';
import { EventBus }      from './events.js';
import { AlpacaBroker }  from './broker/alpaca.js';
import { SaudiBroker }   from './broker/saudi.js';
import { Strategy, SIGNAL } from './strategy.js';
import { RiskManager }   from './risk.js';
import { NewsScanner }   from './news.js';

export const Engine = {
  running: false,
  market: 'US',
  scanTimer: null,
  newsTimer: null,
  eodTimer: null,
  pendingOrders: new Map(),  // orderId → meta
  tradeLog: [],

  get broker() {
    return this.market === 'SA' ? SaudiBroker : AlpacaBroker;
  },

  async start(market = 'US') {
    if (this.running) return;
    this.market = market;
    this.running = true;

    EventBus.emit('engine:starting', { market });

    // Load initial data
    await this._initSession();

    // Start market data stream
    if (market === 'US') {
      AlpacaBroker.connectStream(
        (sym, bar) => this._onBar(sym, bar),
        null
      );
      AlpacaBroker.subscribe(Config.get('usWatchlist'));
      // Pre-load bar history
      await this._preloadHistory('US');
    } else {
      SaudiBroker.startPolling(
        Config.get('saWatchlist'),
        (sym, bar) => this._onBar(sym, bar)
      );
      await this._preloadHistory('SA');
    }

    // Periodic news refresh (every 5 min)
    await NewsScanner.fetchNews();
    await NewsScanner.fetchEconomicCalendar();
    this.newsTimer = setInterval(async () => {
      await NewsScanner.fetchNews(
        market === 'US' ? Config.get('usWatchlist') : []
      );
      await NewsScanner.fetchEconomicCalendar();
    }, 5 * 60 * 1000);

    // Scan loop (every N seconds)
    const interval = Config.get('scanIntervalSec') * 1000;
    this.scanTimer = setInterval(() => this._scan(), interval);

    // End-of-day check every minute
    this.eodTimer = setInterval(() => this._checkEOD(), 60 * 1000);

    EventBus.emit('engine:started', { market });
  },

  async stop() {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.newsTimer) { clearInterval(this.newsTimer); this.newsTimer = null; }
    if (this.eodTimer)  { clearInterval(this.eodTimer);  this.eodTimer  = null; }
    AlpacaBroker.disconnect();
    SaudiBroker.stopPolling();
    EventBus.emit('engine:stopped', {});
  },

  async _initSession() {
    try {
      const acct = await this.broker.getAccount();
      const equity = parseFloat(acct.equity || acct.portfolio_value || acct.cash || 0);
      RiskManager.reset(equity);
      EventBus.emit('account:update', acct);
    } catch (e) {
      EventBus.emit('engine:error', { msg: 'Failed to load account: ' + e.message });
    }
  },

  async _preloadHistory(market) {
    const list = market === 'US' ? Config.get('usWatchlist') : Config.get('saWatchlist');
    // Load in batches of 5 to avoid rate limits
    for (let i = 0; i < list.length; i += 5) {
      const batch = list.slice(i, i + 5);
      await Promise.allSettled(batch.map(async (sym) => {
        const bars = market === 'US'
          ? await AlpacaBroker.getBars(sym, '1Min', 100)
          : await SaudiBroker.getAlphaVantageBars(sym, '5min');
        if (bars.length) {
          if (market === 'US') AlpacaBroker.barHistory[sym] = bars;
          else SaudiBroker.barHistory[sym] = bars;
        }
      }));
      await new Promise(r => setTimeout(r, 300)); // small delay
    }
  },

  async _scan() {
    if (!this.running) return;
    if (!this.broker.isMarketOpen()) return;
    if (RiskManager.getDailyStats().halted) return;

    // Refresh account equity
    try {
      const acct = await this.broker.getAccount();
      const equity = parseFloat(acct.equity || acct.portfolio_value || acct.cash || 0);
      RiskManager.update(equity);
      EventBus.emit('account:update', acct);
    } catch { /* skip */ }

    // Refresh open positions count
    try {
      const positions = await this.broker.getPositions();
      RiskManager.setOpenPositions(Array.isArray(positions) ? positions.length : 0);
      EventBus.emit('positions:update', positions);
    } catch { /* skip */ }

    const canTrade = RiskManager.canTrade();
    if (!canTrade.ok) {
      EventBus.emit('engine:skipped', { reason: canTrade.reason });
      return;
    }

    const watchlist = this.market === 'US'
      ? Config.get('usWatchlist')
      : Config.get('saWatchlist');

    for (const symbol of watchlist) {
      const bars = this.broker.getHistory(symbol);
      if (bars.length < 30) continue;

      const result = Strategy.analyze(symbol, bars);
      EventBus.emit('signal:analyzed', { symbol, ...result });

      if (result.signal === SIGNAL.NONE) continue;
      // Saudi is long-only (no short selling)
      if (this.market === 'SA' && result.signal === SIGNAL.SELL) continue;

      await this._executeSignal(symbol, result);
    }
  },

  async _executeSignal(symbol, { signal, entry, tp, sl, reason }) {
    const canTrade = RiskManager.canTrade();
    if (!canTrade.ok) return;

    const side = signal === SIGNAL.BUY ? 'buy' : 'sell';
    const qty  = RiskManager.positionSize(entry);

    try {
      const order = await this.broker.placeBracketOrder({
        symbol, qty, side,
        entry_price: entry,
        take_profit_price: tp,
        stop_loss_price: sl,
      });

      const trade = {
        id: order.id || Date.now(),
        timestamp: new Date(),
        market: this.market,
        symbol,
        side,
        qty,
        entry,
        tp,
        sl,
        reason,
        status: 'pending',
      };
      this.tradeLog.unshift(trade);
      this.pendingOrders.set(String(order.id || order.client_order_id), trade);
      RiskManager.dailyTrades++;

      EventBus.emit('trade:placed', trade);
      if (Config.get('enableSound')) this._playSound(side);
    } catch (e) {
      EventBus.emit('engine:error', { msg: `Order failed ${symbol}: ${e.message}` });
    }
  },

  async _checkEOD() {
    const closeMin = Config.get('closeMinutesBeforeEnd');
    const minsLeft = this.broker.getMarketMinutesLeft();
    if (minsLeft <= closeMin && minsLeft > closeMin - 1) {
      EventBus.emit('engine:eod', { minsLeft });
      try {
        if (this.market === 'US') {
          await AlpacaBroker.cancelAllOrders();
          await AlpacaBroker.closeAllPositions();
        } else {
          const positions = await SaudiBroker.getPositions();
          for (const p of (positions || [])) {
            await SaudiBroker.closePosition(p.symbol);
          }
        }
        EventBus.emit('engine:allClosed', {});
      } catch (e) {
        EventBus.emit('engine:error', { msg: 'EOD close failed: ' + e.message });
      }
    }
    if (!this.broker.isMarketOpen() && this.running) {
      await this.stop();
      EventBus.emit('engine:marketClosed', {});
    }
  },

  _onBar(symbol, bar) {
    EventBus.emit('price:update', { symbol, bar });
  },

  _playSound(side) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = side === 'buy' ? 880 : 440;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch { /* silence on unsupported env */ }
  },

  getTradeLog() {
    return this.tradeLog;
  },
};
