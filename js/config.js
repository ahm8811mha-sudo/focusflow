// ─── Configuration Manager ────────────────────────────────────────────────────
const DEFAULTS = {
  // Broker Settings
  alpacaMode: 'paper',          // 'paper' | 'live'
  alpacaKey: '',
  alpacaSecret: '',
  saudiBaseUrl: '',             // Your Saudi broker REST base URL
  saudiKey: '',
  saudiSecret: '',
  activeMarket: 'US',           // 'US' | 'SA' | 'BOTH'

  // Strategy Parameters
  volatilityMax: 0.005,         // Max ATR/Price = 0.5% (0:50)
  takeProfitPct: 0.003,         // 0.3% TP
  stopLossPct: 0.002,           // 0.2% SL
  rsiOversold: 35,
  rsiOverbought: 65,
  bbDeviation: 2,
  scanIntervalSec: 30,

  // Risk Management
  riskPerTrade: 0.005,          // 0.5% account risk per trade
  maxPositions: 5,
  dailyLossLimit: 0.02,         // 2% daily max loss
  maxDailyTrades: 30,
  closeMinutesBeforeEnd: 15,    // Exit all X min before market close

  // Watchlists
  usWatchlist: ['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD',
                'BAC','JPM','GS','XOM','CVX','PFE','KO','PEP','WMT','HD'],
  saWatchlist: ['2222','1180','2010','4200','1010','2350','7010','3030','4030','2380',
                '2090','4070','1150','2050','4040','8230','3091','4280','2240','1120'],

  // Notifications
  enableSound: true,
  enableAlerts: true,
  finnhubKey: '',               // Free: finnhub.io

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
    return this;
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

  getAlpacaBase() {
    return this._data.alpacaMode === 'live'
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets';
  },

  getAlpacaDataBase() {
    return 'https://data.alpaca.markets';
  },

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
