// ─── Scalping Strategy ────────────────────────────────────────────────────────
// Conservative mean-reversion scalper:
// • Only trades low-volatility windows (ATR/Price ≤ 0.5%)
// • RSI + Bollinger Bands + MACD confirmation
// • Small TP (0.3%) / tight SL (0.2%)
import { rsi, macd, bollingerBands, atr, volumeRatio } from './indicators.js';
import { Config } from './config.js';
import { NewsScanner } from './news.js';

export const SIGNAL = Object.freeze({ NONE: 0, BUY: 1, SELL: -1 });

export const Strategy = {
  /**
   * Analyze a symbol's bar history and return a trade signal.
   * @param {string} symbol
   * @param {Array}  bars  - [{o,h,l,c,v,t}] oldest-first, min 30 bars
   * @returns {{ signal, reason, entry, tp, sl, volatility }}
   */
  analyze(symbol, bars) {
    const empty = { signal: SIGNAL.NONE, reason: 'insufficient_data' };
    if (!bars || bars.length < 30) return empty;

    const closes  = bars.map(b => b.c);
    const highs   = bars.map(b => b.h);
    const lows    = bars.map(b => b.l);
    const volumes = bars.map(b => b.v);
    const price   = closes[closes.length - 1];

    // ── Volatility filter ─────────────────────────────────────────────────────
    const atrVal = atr(highs, lows, closes, 14);
    const volatility = atrVal ? atrVal / price : 1;
    const maxVol = Config.get('volatilityMax');
    if (volatility > maxVol) {
      return { signal: SIGNAL.NONE, reason: 'high_volatility', volatility };
    }

    // ── Indicator calculations ────────────────────────────────────────────────
    const rsiVal  = rsi(closes, 14);
    const bbVal   = bollingerBands(closes, 20, 2);
    const macdVal = macd(closes, 12, 26, 9);
    const volR    = volumeRatio(volumes, 20);

    if (!rsiVal || !bbVal || !macdVal) return empty;

    // ── News filter ───────────────────────────────────────────────────────────
    if (NewsScanner.hasHighImpactNews(symbol)) {
      return { signal: SIGNAL.NONE, reason: 'high_impact_news', volatility };
    }
    if (NewsScanner.hasUpcomingEvent(30)) {
      return { signal: SIGNAL.NONE, reason: 'upcoming_event', volatility };
    }

    const rsiBuy   = Config.get('rsiOversold');
    const rsiSell  = Config.get('rsiOverbought');
    const tp       = Config.get('takeProfitPct');
    const sl       = Config.get('stopLossPct');

    // ── BUY signal ────────────────────────────────────────────────────────────
    const nearLower  = bbVal.pctB < 0.15;           // price near lower BB
    const oversold   = rsiVal < rsiBuy;
    const macdBull   = macdVal.histogram > -0.01 || macdVal.crossUp;
    const volOk      = !volR || volR >= 0.8;         // don't require huge vol spike

    if (oversold && nearLower && macdBull && volOk) {
      return {
        signal: SIGNAL.BUY,
        reason: `RSI:${rsiVal.toFixed(1)} BB%:${(bbVal.pctB * 100).toFixed(1)}% MACD:${macdVal.histogram.toFixed(4)}`,
        entry: price,
        tp: +(price * (1 + tp)).toFixed(4),
        sl: +(price * (1 - sl)).toFixed(4),
        volatility,
      };
    }

    // ── SELL signal (short – US only; Saudi is long-only) ─────────────────────
    const nearUpper  = bbVal.pctB > 0.85;
    const overbought = rsiVal > rsiSell;
    const macdBear   = macdVal.histogram < 0.01 || macdVal.crossDown;

    if (overbought && nearUpper && macdBear && volOk) {
      return {
        signal: SIGNAL.SELL,
        reason: `RSI:${rsiVal.toFixed(1)} BB%:${(bbVal.pctB * 100).toFixed(1)}% MACD:${macdVal.histogram.toFixed(4)}`,
        entry: price,
        tp: +(price * (1 - tp)).toFixed(4),
        sl: +(price * (1 + sl)).toFixed(4),
        volatility,
      };
    }

    return { signal: SIGNAL.NONE, reason: 'no_signal', volatility };
  },
};
