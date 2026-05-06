// ─── News & Economic Calendar ──────────────────────────────────────────────────
import { Config } from './config.js';
import { AlpacaBroker } from './broker/alpaca.js';

const IMPACT_KEYWORDS = [
  'fed', 'fomc', 'interest rate', 'cpi', 'inflation', 'gdp', 'unemployment',
  'nonfarm', 'payroll', 'ecb', 'earnings', 'guidance', 'warning', 'crash',
  'halt', 'bankrupt', 'fraud', 'sec', 'lawsuit', 'recall', 'اسعار الفائدة',
  'تضخم', 'ناتج محلي', 'ساما', 'أرباح', 'توقف التداول', 'أرامكو',
];

export const NewsScanner = {
  latestNews: [],
  economicEvents: [],
  highImpactSymbols: new Set(),
  lastFetch: 0,

  async fetchNews(symbols = []) {
    try {
      const items = await AlpacaBroker.getNews(symbols, 30);
      this.latestNews = items.map(n => ({
        id: n.id,
        headline: n.headline,
        summary: n.summary || '',
        symbols: n.symbols || [],
        createdAt: new Date(n.created_at),
        url: n.url,
        impact: this._assessImpact(n.headline + ' ' + (n.summary || '')),
      }));
      this._updateHighImpactSymbols();
      this.lastFetch = Date.now();
    } catch { /* offline */ }
    return this.latestNews;
  },

  async fetchEconomicCalendar() {
    const key = Config.get('finnhubKey');
    if (!key) return [];
    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await fetch(
        `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${key}`
      );
      const data = await res.json();
      this.economicEvents = (data.economicCalendar || []).map(e => ({
        event: e.event,
        country: e.country,
        impact: e.impact,
        time: e.time,
        actual: e.actual,
        estimate: e.estimate,
      }));
    } catch { /* skip */ }
    return this.economicEvents;
  },

  _assessImpact(text) {
    const t = text.toLowerCase();
    for (const kw of IMPACT_KEYWORDS) {
      if (t.includes(kw.toLowerCase())) return 'high';
    }
    return 'low';
  },

  _updateHighImpactSymbols() {
    this.highImpactSymbols.clear();
    const cutoff = new Date(Date.now() - 30 * 60 * 1000); // last 30 min
    for (const n of this.latestNews) {
      if (n.impact === 'high' && n.createdAt >= cutoff) {
        n.symbols.forEach(s => this.highImpactSymbols.add(s));
      }
    }
  },

  hasHighImpactNews(symbol) {
    return this.highImpactSymbols.has(symbol);
  },

  hasUpcomingEvent(minutesAhead = 30) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + minutesAhead * 60 * 1000);
    return this.economicEvents.some(e => {
      const t = new Date(e.time);
      return e.impact === 'high' && t >= now && t <= cutoff;
    });
  },

  getRecentNews(limit = 10) {
    return this.latestNews.slice(0, limit);
  },
};
