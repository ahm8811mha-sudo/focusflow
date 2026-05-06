// ─── Alpaca Broker (US Markets) ───────────────────────────────────────────────
import { Config } from '../config.js';
import { EventBus } from '../events.js';

export const AlpacaBroker = {
  ws: null,
  streamingSymbols: new Set(),
  priceCache: {},         // symbol → { open,high,low,close,volume,timestamp }
  barHistory: {},         // symbol → [{ c, h, l, o, v, t }]
  authenticated: false,

  async request(path, method = 'GET', body = null, dataApi = false) {
    const base = dataApi ? Config.getAlpacaDataBase() : Config.getAlpacaBase();
    const opts = { method, headers: Config.getAlpacaHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(base + path, opts);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Alpaca ${method} ${path} → ${res.status}: ${err}`);
    }
    return res.json();
  },

  async getAccount() {
    return this.request('/v2/account');
  },

  async getPositions() {
    return this.request('/v2/positions');
  },

  async getOrders(status = 'open') {
    return this.request(`/v2/orders?status=${status}&limit=100`);
  },

  async placeOrder({ symbol, qty, side, type = 'market', limit_price, time_in_force = 'day' }) {
    const body = { symbol, qty: String(qty), side, type, time_in_force };
    if (type === 'limit' && limit_price) body.limit_price = String(limit_price);
    return this.request('/v2/orders', 'POST', body);
  },

  async placeBracketOrder({ symbol, qty, side, entry_price, take_profit_price, stop_loss_price }) {
    const body = {
      symbol,
      qty: String(qty),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: String(entry_price),
      order_class: 'bracket',
      take_profit: { limit_price: String(take_profit_price) },
      stop_loss: { stop_price: String(stop_loss_price) },
    };
    return this.request('/v2/orders', 'POST', body);
  },

  async cancelOrder(orderId) {
    return this.request(`/v2/orders/${orderId}`, 'DELETE');
  },

  async cancelAllOrders() {
    return this.request('/v2/orders', 'DELETE');
  },

  async closePosition(symbol) {
    return this.request(`/v2/positions/${symbol}`, 'DELETE');
  },

  async closeAllPositions() {
    return this.request('/v2/positions?cancel_orders=true', 'DELETE');
  },

  async getBars(symbol, timeframe = '1Min', limit = 100) {
    const path = `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`;
    try {
      const data = await this.request(path, 'GET', null, true);
      return (data.bars || []).map(b => ({
        t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
      }));
    } catch {
      return [];
    }
  },

  async getSnapshot(symbol) {
    try {
      const path = `/v2/stocks/${symbol}/snapshot?feed=iex`;
      return this.request(path, 'GET', null, true);
    } catch {
      return null;
    }
  },

  async getSnapshots(symbols) {
    if (!symbols.length) return {};
    try {
      const syms = symbols.slice(0, 50).join(',');
      const path = `/v2/stocks/snapshots?symbols=${syms}&feed=iex`;
      return this.request(path, 'GET', null, true);
    } catch {
      return {};
    }
  },

  async getNews(symbols = [], limit = 20) {
    try {
      const symParam = symbols.length ? `&symbols=${symbols.join(',')}` : '';
      const path = `/v1beta1/news?limit=${limit}${symParam}`;
      const data = await this.request(path, 'GET', null, true);
      return data.news || [];
    } catch {
      return [];
    }
  },

  // ── WebSocket Streaming ─────────────────────────────────────────────────────
  connectStream(onBar, onTrade) {
    if (this.ws) return;
    const wsUrl = 'wss://stream.data.alpaca.markets/v2/iex';
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        action: 'auth',
        key: Config.get('alpacaKey'),
        secret: Config.get('alpacaSecret'),
      }));
    };

    this.ws.onmessage = (ev) => {
      const msgs = JSON.parse(ev.data);
      for (const msg of msgs) {
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          this.authenticated = true;
          EventBus.emit('broker:connected', { market: 'US' });
          this._resubscribe();
        }
        if (msg.T === 'b') {   // bar
          const bar = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
          if (!this.barHistory[msg.S]) this.barHistory[msg.S] = [];
          this.barHistory[msg.S].push(bar);
          if (this.barHistory[msg.S].length > 200) this.barHistory[msg.S].shift();
          this.priceCache[msg.S] = bar;
          if (onBar) onBar(msg.S, bar);
        }
        if (msg.T === 't') {   // trade tick
          if (onTrade) onTrade(msg.S, msg);
        }
        if (msg.T === 'error') {
          EventBus.emit('broker:error', { market: 'US', msg: msg.msg });
        }
      }
    };

    this.ws.onclose = () => {
      this.authenticated = false;
      this.ws = null;
      EventBus.emit('broker:disconnected', { market: 'US' });
    };

    this.ws.onerror = (e) => {
      EventBus.emit('broker:error', { market: 'US', msg: 'WebSocket error' });
    };
  },

  subscribe(symbols) {
    symbols.forEach(s => this.streamingSymbols.add(s));
    if (this.authenticated) this._resubscribe();
  },

  _resubscribe() {
    if (!this.ws || !this.authenticated) return;
    const syms = [...this.streamingSymbols];
    if (!syms.length) return;
    this.ws.send(JSON.stringify({ action: 'subscribe', bars: syms, trades: syms }));
  },

  disconnect() {
    if (this.ws) { this.ws.close(); this.ws = null; }
  },

  getLatestPrice(symbol) {
    return this.priceCache[symbol]?.c ?? null;
  },

  getHistory(symbol) {
    return this.barHistory[symbol] ?? [];
  },

  isMarketOpen() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const h = et.getHours(), m = et.getMinutes();
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  },

  getMarketMinutesLeft() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = et.getHours(), m = et.getMinutes();
    return (16 * 60) - (h * 60 + m);
  },
};
