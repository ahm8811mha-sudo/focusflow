// ─── Suggestions Engine ────────────────────────────────────────────────────────
// Scans all watchlist symbols and ranks them by investment opportunity strength
import { Config }                                     from './config.js';
import { Strategy }                                   from './strategy.js';
import { rsi, bollingerBands, macd, atr, volumeRatio } from './indicators.js';
import { NewsScanner }                                from './news.js';

export const SuggestionsEngine = {
  lastScan: null,
  results: [],
  scanning: false,

  async scan() {
    if (this.scanning) return this.results;
    this.scanning = true;
    const results = [];

    const usPortfolio = Config.getPortfolios().find(p => p.market === 'US' && p.key && p.secret);
    const avKey = Config.get('alphaVantageKey');

    // ── US watchlist ──────────────────────────────────────────────────────────
    if (usPortfolio) {
      const usWl = Config.get('usWatchlist');
      for (let i = 0; i < usWl.length; i += 5) {
        await Promise.allSettled(usWl.slice(i, i + 5).map(async sym => {
          const bars = await this._fetchAlpacaBars(sym, usPortfolio).catch(() => []);
          if (bars.length >= 30) {
            const analysis = Strategy.analyze(sym, bars);
            results.push({
              symbol: sym, market: 'US',
              ...analysis,
              score: this._score(bars, analysis, sym),
              rsiVal: rsi(bars.map(b => b.c), 14),
              bbVal:  bollingerBands(bars.map(b => b.c), 20, 2),
            });
          }
        }));
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // ── SA watchlist ──────────────────────────────────────────────────────────
    if (avKey) {
      const saWl = Config.get('saWatchlist').slice(0, 5); // respect free-tier rate limit
      for (const sym of saWl) {
        const bars = await this._fetchAVBars(sym, avKey).catch(() => []);
        if (bars.length >= 30) {
          const analysis = Strategy.analyze(sym, bars);
          results.push({
            symbol: sym, market: 'SA',
            ...analysis,
            score: this._score(bars, analysis, sym),
            rsiVal: rsi(bars.map(b => b.c), 14),
            bbVal:  bollingerBands(bars.map(b => b.c), 20, 2),
          });
        }
        await new Promise(r => setTimeout(r, 1500)); // AV free tier: 5 req/min
      }
    }

    results.sort((a, b) => b.score - a.score);
    this.results  = results;
    this.lastScan = new Date();
    this.scanning = false;
    return results;
  },

  // Score 0–100: measures how close a symbol is to an ideal trade setup
  _score(bars, analysis, symbol) {
    const closes  = bars.map(b => b.c);
    const price   = closes[closes.length - 1];
    const rsiVal  = rsi(closes, 14) ?? 50;
    const bb      = bollingerBands(closes, 20, 2);
    const m       = macd(closes, 12, 26, 9);
    const atrVal  = atr(bars.map(b => b.h), bars.map(b => b.l), closes, 14);
    const volR    = volumeRatio(bars.map(b => b.v), 20);
    const volatility = atrVal ? atrVal / price : 1;

    let score = 40;

    // Volatility: low is better for scalping
    if (volatility < 0.003)      score += 20;
    else if (volatility < 0.005) score += 10;
    else                         score -= 20;

    // RSI: reward extremes (near oversold/overbought)
    const rsiBuy  = Config.get('rsiOversold');
    const rsiSell = Config.get('rsiOverbought');
    if (rsiVal < rsiBuy + 5 || rsiVal > rsiSell - 5) score += 15;

    // BB: reward price near the bands
    if (bb) {
      const nearBand = bb.pctB < 0.15 || bb.pctB > 0.85;
      if (nearBand) score += 15;
    }

    // MACD: reward crossovers
    if (m) {
      if (m.crossUp || m.crossDown) score += 15;
      else if (Math.abs(m.histogram) < 0.005) score += 5;
    }

    // Volume ratio: reward above-average volume
    if (volR && volR >= 1.2) score += 10;

    // Active signal: strongest indicator
    if (analysis.signal !== 0) score += 20;

    // Penalise high-impact news
    if (NewsScanner.hasHighImpactNews(symbol)) score -= 25;

    return Math.round(Math.max(0, Math.min(100, score)));
  },

  async _fetchAlpacaBars(symbol, portfolio) {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Min&limit=100&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': portfolio.key, 'APCA-API-SECRET-KEY': portfolio.secret } }
    );
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    return (data.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  },

  async _fetchAVBars(symbol, avKey) {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${symbol}.SR&interval=5min&apikey=${avKey}&outputsize=compact`
    );
    const data = await res.json();
    const key = 'Time Series (5min)';
    if (!data[key]) return [];
    return Object.entries(data[key]).slice(0, 100).map(([t, v]) => ({
      t, o: +v['1. open'], h: +v['2. high'], l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'],
    })).reverse();
  },
};
