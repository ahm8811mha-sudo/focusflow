// ─── Multi-Portfolio Engine ────────────────────────────────────────────────────
import { Config }           from './config.js';
import { EventBus }         from './events.js';
import { Strategy, SIGNAL } from './strategy.js';
import { NewsScanner }      from './news.js';

function createPortfolioEngine(portfolio) {
  const pid = portfolio.id;
  const risk = {
    sessionStartEquity: 0, currentEquity: 0, dailyPnL: 0,
    dailyTrades: 0, dailyLossHalt: false, openPositionCount: 0,
  };
  const barHistory = {};
  const priceCache  = {};
  let ws = null, wsAuthenticated = false;
  let running = false;
  let scanTimer = null, newsTimer = null, eodTimer = null, pollTimer = null;
  const tradeLog = [];

  // ── HTTP helpers ──────────────────────────────────────────────────────────────
  async function alpacaReq(path, method = 'GET', body = null, dataApi = false) {
    const base = dataApi
      ? 'https://data.alpaca.markets'
      : (portfolio.mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets');
    const res = await fetch(base + path, {
      method,
      headers: {
        'APCA-API-KEY-ID': portfolio.key,
        'APCA-API-SECRET-KEY': portfolio.secret,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function saudiReq(path, method = 'GET', body = null) {
    const base = (portfolio.baseUrl || '').replace(/\/$/, '');
    const res = await fetch(base + path, {
      method,
      headers: {
        'Authorization': `Bearer ${portfolio.key}`,
        'X-API-Secret': portfolio.secret,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Saudi ${res.status}`);
    return res.json();
  }

  // ── Market hours ──────────────────────────────────────────────────────────────
  function isMarketOpen() {
    const now = new Date();
    if (portfolio.market === 'SA') {
      const r = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
      if (r.getDay() === 5 || r.getDay() === 6) return false;
      const m = r.getHours() * 60 + r.getMinutes();
      return m >= 600 && m < 900;
    }
    const e = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (e.getDay() === 0 || e.getDay() === 6) return false;
    const m = e.getHours() * 60 + e.getMinutes();
    return m >= 570 && m < 960;
  }

  function getMinutesLeft() {
    const now = new Date();
    if (portfolio.market === 'SA') {
      const r = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
      return 900 - (r.getHours() * 60 + r.getMinutes());
    }
    const e = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return 960 - (e.getHours() * 60 + e.getMinutes());
  }

  // ── Broker ops ────────────────────────────────────────────────────────────────
  async function getAccount() {
    return portfolio.market === 'SA' ? saudiReq('/account') : alpacaReq('/v2/account');
  }

  async function getPositions() {
    return portfolio.market === 'SA' ? saudiReq('/positions') : alpacaReq('/v2/positions');
  }

  async function getBars(symbol) {
    if (portfolio.market === 'SA') {
      const av = Config.get('alphaVantageKey');
      if (!av) return [];
      try {
        const res = await fetch(
          `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${symbol}.SR&interval=5min&apikey=${av}&outputsize=compact`
        );
        const data = await res.json();
        const key = 'Time Series (5min)';
        if (!data[key]) return [];
        return Object.entries(data[key]).slice(0, 100).map(([t, v]) => ({
          t, o: +v['1. open'], h: +v['2. high'], l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'],
        })).reverse();
      } catch { return []; }
    }
    try {
      const data = await alpacaReq(
        `/v2/stocks/${symbol}/bars?timeframe=1Min&limit=100&feed=iex`, 'GET', null, true
      );
      return (data.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    } catch { return []; }
  }

  async function placeBracketOrder({ symbol, qty, side, entry_price, take_profit_price, stop_loss_price }) {
    if (portfolio.market === 'SA') {
      return saudiReq('/orders', 'POST', {
        symbol, qty, side, type: 'limit',
        limit_price: entry_price, take_profit: take_profit_price, stop_loss: stop_loss_price,
      });
    }
    return alpacaReq('/v2/orders', 'POST', {
      symbol, qty: String(qty), side, type: 'limit', time_in_force: 'day',
      limit_price: String(entry_price), order_class: 'bracket',
      take_profit: { limit_price: String(take_profit_price) },
      stop_loss: { stop_price: String(stop_loss_price) },
    });
  }

  async function closeAll() {
    if (portfolio.market === 'SA') {
      const pos = await getPositions().catch(() => []);
      for (const p of (pos || [])) {
        await saudiReq(`/positions/${p.symbol}`, 'DELETE').catch(() => {});
      }
    } else {
      await alpacaReq('/v2/positions?cancel_orders=true', 'DELETE');
    }
  }

  // ── WebSocket (US only) ───────────────────────────────────────────────────────
  function connectStream() {
    if (ws) return;
    ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
    ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: portfolio.key, secret: portfolio.secret }));
    ws.onmessage = (ev) => {
      const msgs = JSON.parse(ev.data);
      for (const msg of msgs) {
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          wsAuthenticated = true;
          EventBus.emit('broker:connected', { market: 'US', pid });
          const wl = Config.get('usWatchlist');
          ws.send(JSON.stringify({ action: 'subscribe', bars: wl, trades: wl }));
        }
        if (msg.T === 'b') {
          const bar = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
          if (!barHistory[msg.S]) barHistory[msg.S] = [];
          barHistory[msg.S].push(bar);
          if (barHistory[msg.S].length > 200) barHistory[msg.S].shift();
          priceCache[msg.S] = bar;
          EventBus.emit('price:update', { symbol: msg.S, bar, pid });
        }
        if (msg.T === 'error') EventBus.emit('broker:error', { market: 'US', msg: msg.msg, pid });
      }
    };
    ws.onclose = () => {
      ws = null; wsAuthenticated = false;
      EventBus.emit('broker:disconnected', { market: 'US', pid });
    };
    ws.onerror = () => EventBus.emit('broker:error', { market: 'US', msg: 'WebSocket error', pid });
  }

  // ── Risk helpers ──────────────────────────────────────────────────────────────
  function canTrade() {
    if (risk.dailyLossHalt) return { ok: false, reason: 'daily_loss_limit' };
    if (risk.openPositionCount >= Config.get('maxPositions')) return { ok: false, reason: 'max_positions' };
    if (risk.dailyTrades >= Config.get('maxDailyTrades')) return { ok: false, reason: 'max_daily_trades' };
    return { ok: true };
  }

  function positionSize(entry) {
    if (!risk.currentEquity || !entry) return 1;
    const r = risk.currentEquity * Config.get('riskPerTrade');
    const dist = entry * Config.get('stopLossPct');
    return Math.max(1, Math.floor(r / dist));
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────────
  async function initSession() {
    try {
      const acct = await getAccount();
      const eq = parseFloat(acct.equity || acct.portfolio_value || acct.cash || 0);
      Object.assign(risk, { sessionStartEquity: eq, currentEquity: eq, dailyPnL: 0, dailyTrades: 0, dailyLossHalt: false, openPositionCount: 0 });
      EventBus.emit('account:update', { ...acct, pid });
    } catch (e) {
      EventBus.emit('engine:error', { msg: 'فشل تحميل الحساب: ' + e.message, pid });
    }
  }

  async function preloadHistory() {
    const wl = portfolio.market === 'US' ? Config.get('usWatchlist') : Config.get('saWatchlist');
    for (let i = 0; i < wl.length; i += 5) {
      await Promise.allSettled(wl.slice(i, i + 5).map(async sym => {
        const bars = await getBars(sym);
        if (bars.length) barHistory[sym] = bars;
      }));
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async function scan() {
    if (!running || !isMarketOpen() || risk.dailyLossHalt) return;
    try {
      const acct = await getAccount();
      const eq = parseFloat(acct.equity || acct.portfolio_value || acct.cash || 0);
      risk.currentEquity = eq;
      risk.dailyPnL = eq - risk.sessionStartEquity;
      if (risk.dailyPnL <= -(risk.sessionStartEquity * Config.get('dailyLossLimit')) && !risk.dailyLossHalt) {
        risk.dailyLossHalt = true;
        EventBus.emit('risk:dailyLimitHit', { pnl: risk.dailyPnL, pid });
      }
      EventBus.emit('account:update', { ...acct, pid });
    } catch { /* skip */ }

    try {
      const pos = await getPositions();
      risk.openPositionCount = Array.isArray(pos) ? pos.length : 0;
      EventBus.emit('positions:update', { positions: pos, pid });
    } catch { /* skip */ }

    const check = canTrade();
    if (!check.ok) { EventBus.emit('engine:skipped', { reason: check.reason, pid }); return; }

    const wl = portfolio.market === 'US' ? Config.get('usWatchlist') : Config.get('saWatchlist');
    for (const sym of wl) {
      const bars = barHistory[sym] || [];
      if (bars.length < 30) continue;
      const result = Strategy.analyze(sym, bars);
      EventBus.emit('signal:analyzed', { symbol: sym, ...result, pid });
      if (result.signal === SIGNAL.NONE) continue;
      if (portfolio.market === 'SA' && result.signal === SIGNAL.SELL) continue;
      if (!canTrade().ok) break;
      const side = result.signal === SIGNAL.BUY ? 'buy' : 'sell';
      const qty  = positionSize(result.entry);
      try {
        const order = await placeBracketOrder({
          symbol: sym, qty, side,
          entry_price: result.entry, take_profit_price: result.tp, stop_loss_price: result.sl,
        });
        const trade = {
          id: order.id || Date.now(), timestamp: new Date(),
          market: portfolio.market, symbol: sym, side, qty,
          entry: result.entry, tp: result.tp, sl: result.sl,
          reason: result.reason, status: 'pending', pid,
          portfolioName: portfolio.name,
        };
        tradeLog.unshift(trade);
        risk.dailyTrades++;
        EventBus.emit('trade:placed', trade);
        if (Config.get('enableSound')) _playSound(side);
      } catch (e) {
        EventBus.emit('engine:error', { msg: `فشل الأمر ${sym}: ${e.message}`, pid });
      }
    }
  }

  async function checkEOD() {
    const closeMin  = Config.get('closeMinutesBeforeEnd');
    const minsLeft  = getMinutesLeft();
    if (minsLeft <= closeMin && minsLeft > closeMin - 1) {
      EventBus.emit('engine:eod', { minsLeft, pid });
      await closeAll().catch(e => EventBus.emit('engine:error', { msg: 'فشل الإغلاق: ' + e.message, pid }));
      EventBus.emit('engine:allClosed', { pid });
    }
    if (!isMarketOpen() && running) { stop(); EventBus.emit('engine:marketClosed', { pid }); }
  }

  function _playSound(side) {
    try {
      const ctx  = new AudioContext();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = side === 'buy' ? 880 : 440;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
    } catch { /* silence */ }
  }

  async function start() {
    if (running) return;
    running = true;
    EventBus.emit('engine:starting', { market: portfolio.market, pid, name: portfolio.name });
    await initSession();
    if (portfolio.market === 'US') {
      connectStream();
    } else {
      const wl = Config.get('saWatchlist');
      pollTimer = setInterval(async () => {
        for (const sym of wl) {
          const bars = await getBars(sym).catch(() => []);
          if (bars.length) {
            barHistory[sym] = bars;
            priceCache[sym] = bars[bars.length - 1];
            EventBus.emit('price:update', { symbol: sym, bar: bars[bars.length - 1], pid });
          }
        }
      }, 30000);
      EventBus.emit('broker:connected', { market: 'SA', pid });
    }
    await preloadHistory();
    await NewsScanner.fetchNews();
    await NewsScanner.fetchEconomicCalendar();
    newsTimer = setInterval(async () => {
      await NewsScanner.fetchNews(portfolio.market === 'US' ? Config.get('usWatchlist') : []);
      await NewsScanner.fetchEconomicCalendar();
    }, 5 * 60 * 1000);
    scanTimer = setInterval(() => scan(), Config.get('scanIntervalSec') * 1000);
    eodTimer  = setInterval(() => checkEOD(), 60 * 1000);
    EventBus.emit('engine:started', { market: portfolio.market, pid, name: portfolio.name });
  }

  function stop() {
    running = false;
    [scanTimer, newsTimer, eodTimer, pollTimer].forEach(t => t && clearInterval(t));
    scanTimer = newsTimer = eodTimer = pollTimer = null;
    if (ws) { ws.close(); ws = null; }
    EventBus.emit('engine:stopped', { pid, market: portfolio.market, name: portfolio.name });
  }

  return {
    get isRunning()    { return running; },
    get portfolioId()  { return pid; },
    get portfolioName(){ return portfolio.name; },
    get market()       { return portfolio.market; },
    get tradeLog()     { return tradeLog; },
    getRiskStats() {
      return {
        pnl: risk.dailyPnL,
        pnlPct: risk.sessionStartEquity ? risk.dailyPnL / risk.sessionStartEquity * 100 : 0,
        trades: risk.dailyTrades,
        halted: risk.dailyLossHalt,
        equity: risk.currentEquity,
      };
    },
    getLatestPrice: sym => priceCache[sym]?.c ?? null,
    start,
    stop,
  };
}

// ─── Portfolio Manager ─────────────────────────────────────────────────────────
export const PortfolioManager = {
  _engines: new Map(),

  start(pid) {
    const p = Config.getPortfolio(pid);
    if (!p) return false;
    if (!Config.isPortfolioConfigured(p)) {
      EventBus.emit('engine:error', { msg: `المحفظة "${p.name}" غير مكتملة – أدخل بيانات API في الإعدادات`, pid });
      return false;
    }
    let engine = this._engines.get(pid);
    if (engine?.isRunning) return true;
    engine = createPortfolioEngine(p);
    this._engines.set(pid, engine);
    engine.start();
    return true;
  },

  stop(pid) {
    this._engines.get(pid)?.stop();
  },

  stopAll() {
    this._engines.forEach(e => e.stop());
  },

  isRunning(pid) {
    return this._engines.get(pid)?.isRunning ?? false;
  },

  getRiskStats(pid) {
    return this._engines.get(pid)?.getRiskStats() ?? null;
  },

  getAllTradeLog() {
    return [...this._engines.values()]
      .flatMap(e => e.tradeLog)
      .sort((a, b) => b.timestamp - a.timestamp);
  },
};
