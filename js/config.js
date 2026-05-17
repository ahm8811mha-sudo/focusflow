// ─── Configuration Manager ────────────────────────────────────────────────────
const DEFAULTS = {
  // Legacy single-broker (migrated to portfolios array on first load)
  alpacaMode: 'paper',
  alpacaKey: '',
  alpacaSecret: '',
  saudiBaseUrl: '',
  saudiKey: '',
  saudiSecret: '',

  // Multi-portfolio
  portfolios: [],

  // Strategy Parameters
  volatilityMax: 0.005,
  takeProfitPct: 0.003,
  stopLossPct: 0.002,
  rsiOversold: 35,
  rsiOverbought: 65,
  bbDeviation: 2,
  scanIntervalSec: 30,

  // Risk Management
  riskPerTrade: 0.005,
  maxPositions: 5,
  dailyLossLimit: 0.02,
  maxDailyTrades: 30,
  closeMinutesBeforeEnd: 15,

  // Watchlists
  usWatchlist: ['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD',
                'BAC','JPM','GS','XOM','CVX','PFE','KO','PEP','WMT','HD'],
  saWatchlist: ['2222','1180','2010','4200','1010','2350','7010','3030','4030','2380',
                '2090','4070','1150','2050','4040','8230','3091','4280','2240','1120'],

  // Notifications
  enableSound: true,
  enableAlerts: true,
  finnhubKey: '',
  alphaVantageKey: '',

  // UI
  theme: 'dark',
  language: 'ar',
};

export const Config = {
  _data: {},

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('tradingConfig') || '{}');
      this._data = { ...DEFAULTS, ...saved };
    } catch {
      this._data = { ...DEFAULTS };
    }
    this._migrateLegacy();
    return this;
  },

  _migrateLegacy() {
    if (!Array.isArray(this._data.portfolios) || this._data.portfolios.length === 0) {
      this._data.portfolios = [
        {
          id: 'p_us_1',
          name: 'محفظة أمريكية 1',
          market: 'US',
          mode: this._data.alpacaMode || 'paper',
          key: this._data.alpacaKey || '',
          secret: this._data.alpacaSecret || '',
        },
        {
          id: 'p_sa_1',
          name: 'محفظة سعودية 1',
          market: 'SA',
          baseUrl: this._data.saudiBaseUrl || '',
          key: this._data.saudiKey || '',
          secret: this._data.saudiSecret || '',
        },
      ];
      this.save();
    }
  },

  save() {
    localStorage.setItem('tradingConfig', JSON.stringify(this._data));
  },

  get(key) {
    return this._data[key] ?? DEFAULTS[key];
  },

  set(key, value) {
    this._data[key] = value;
    this.save();
  },

  setMany(obj) {
    Object.assign(this._data, obj);
    this.save();
  },

  getPortfolios() {
    return this._data.portfolios || [];
  },

  getPortfolio(id) {
    return (this._data.portfolios || []).find(p => p.id === id);
  },

  savePortfolio(portfolio) {
    const arr = this._data.portfolios || [];
    const idx = arr.findIndex(p => p.id === portfolio.id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...portfolio };
    else arr.push(portfolio);
    this._data.portfolios = arr;
    this.save();
  },

  deletePortfolio(id) {
    this._data.portfolios = (this._data.portfolios || []).filter(p => p.id !== id);
    this.save();
  },

  addPortfolio(market) {
    const portfolios = this._data.portfolios || [];
    const count = portfolios.filter(p => p.market === market).length;
    const id = `p_${market.toLowerCase()}_${Date.now()}`;
    const portfolio = market === 'US'
      ? { id, name: `محفظة أمريكية ${count + 1}`, market: 'US', mode: 'paper', key: '', secret: '' }
      : { id, name: `محفظة سعودية ${count + 1}`, market: 'SA', baseUrl: '', key: '', secret: '' };
    portfolios.push(portfolio);
    this._data.portfolios = portfolios;
    this.save();
    return portfolio;
  },

  isPortfolioConfigured(portfolio) {
    if (!portfolio) return false;
    if (portfolio.market === 'US') return !!(portfolio.key && portfolio.secret);
    if (portfolio.market === 'SA') return !!(portfolio.baseUrl && portfolio.key);
    return false;
  },

  // Legacy compat (used by broker files / news)
  getAlpacaBase() {
    return this._data.alpacaMode === 'live'
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets';
  },
  getAlpacaDataBase() { return 'https://data.alpaca.markets'; },
  getAlpacaHeaders() {
    return {
      'APCA-API-KEY-ID': this._data.alpacaKey,
      'APCA-API-SECRET-KEY': this._data.alpacaSecret,
      'Content-Type': 'application/json',
    };
  },
  getSaudiHeaders() {
    return {
      'Authorization': `Bearer ${this._data.saudiKey}`,
      'X-API-Secret': this._data.saudiSecret,
      'Content-Type': 'application/json',
    };
  },
  isConfigured(market) {
    if (market === 'US') return !!(this._data.alpacaKey && this._data.alpacaSecret);
    if (market === 'SA') return !!(this._data.saudiBaseUrl && this._data.saudiKey);
    return false;
  },
};
