// ─── Saudi Market Broker (Generic REST Interface) ─────────────────────────────
// Compatible with: Al-Rajhi Capital, SNB Capital, Aljazira, Mubasher, etc.
// Configure your broker's REST API base URL + credentials in Settings
import { Config } from '../config.js';
import { EventBus } from '../events.js';

export const SaudiBroker = {
  priceCache: {},
  barHistory: {},
  pollTimer: null,
  pollSymbols: new Set(),

  async request(path, method = 'GET', body = null) {
    const base = Config.get('saudiBaseUrl').replace(/\/$/, '');
    const opts = { method, headers: Config.getSaudiHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(base + path, opts);
    if (!res.ok) throw new Error(`Saudi ${method} ${path} → ${res.status}`);
    return res.json();
  },

  async getAccount() {
    return this.request('/account');
  },

  async getPositions() {
    return this.request('/positions');
  },

  async getOrders() {
    return this.request('/orders?status=open');
  },

  async placeOrder({ symbol, qty, side, type = 'market', limit_price }) {
    const body = { symbol, qty, side, type };
    if (limit_price) body.limit_price = limit_price;
    return this.request('/orders', 'POST', body);
  },

  async placeBracketOrder({ symbol, qty, side, entry_price, take_profit_price, stop_loss_price }) {
    return this.request('/orders', 'POST', {
      symbol, qty, side,
      type: 'limit',
      limit_price: entry_price,
      take_profit: take_profit_price,
      stop_loss: stop_loss_price,
    });
  },

  async cancelOrder(orderId) {
    return this.request(`/orders/${orderId}`, 'DELETE');
  },

  async closePosition(symbol) {
    return this.request(`/positions/${symbol}`, 'DELETE');
  },

  async getQuote(symbol) {
    return this.request(`/quotes/${symbol}`);
  },

  async getBars(symbol, timeframe = '1', limit = 100) {
    return this.request(`/bars/${symbol}?timeframe=${timeframe}&limit=${limit}`);
  },

  // Tadawul data via Alpha Vantage (free tier, SR suffix)
  async getAlphaVantageBars(symbol, interval = '1min') {
    const av = Config.get('alphaVantageKey');
    if (!av) return [];
    const sym = symbol + '.SR';
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${sym}&interval=${interval}&apikey=${av}&outputsize=compact`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      const key = `Time Series (${interval})`;
      if (!data[key]) return [];
      return Object.entries(data[key]).slice(0, 100).map(([t, v]) => ({
        t, o: +v['1. open'], h: +v['2. high'],
        l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'],
      })).reverse();
    } catch {
      return [];
    }
  },

  // Poll prices every 30s (Saudi market has slower tick data for retail)
  startPolling(symbols, onBar) {
    symbols.forEach(s => this.pollSymbols.add(s));
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      for (const sym of this.pollSymbols) {
        try {
          const bars = await this.getAlphaVantageBars(sym);
          if (bars.length) {
            this.barHistory[sym] = bars;
            const last = bars[bars.length - 1];
            this.priceCache[sym] = last;
            if (onBar) onBar(sym, last);
          }
        } catch { /* skip */ }
      }
    }, 30000);
    EventBus.emit('broker:connected', { market: 'SA' });
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  getLatestPrice(symbol) {
    return this.priceCache[symbol]?.c ?? null;
  },

  getHistory(symbol) {
    return this.barHistory[symbol] ?? [];
  },

  // Tadawul (Saudi Exchange) sessions – Riyadh time (UTC+3)
  isMarketOpen() {
    const now = new Date();
    const riyad = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
    const day = riyad.getDay();
    // Friday (5) and Saturday (6) are weekend
    if (day === 5 || day === 6) return false;
    const h = riyad.getHours(), m = riyad.getMinutes();
    const mins = h * 60 + m;
    // Pre-open: 9:30, Main: 10:00-15:00, After: 15:00-15:30
    return mins >= 10 * 60 && mins < 15 * 60;
  },

  getMarketMinutesLeft() {
    const now = new Date();
    const riyad = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
    const h = riyad.getHours(), m = riyad.getMinutes();
    return (15 * 60) - (h * 60 + m);
  },
};
