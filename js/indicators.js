// ─── Technical Indicators (Pure Functions) ────────────────────────────────────

export function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

export function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) val = prices[i] * k + val * (1 - k);
  return val;
}

export function emaHistory(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(val);
  for (let i = period; i < prices.length; i++) {
    val = prices[i] * k + val * (1 - k);
    out.push(val);
  }
  return out;
}

export function macd(prices, fast = 12, slow = 26, signal = 9) {
  if (prices.length < slow + signal) return null;
  const fastH = emaHistory(prices, fast);
  const slowH = emaHistory(prices, slow);
  const len = Math.min(fastH.length, slowH.length);
  const macdLine = Array.from({ length: len }, (_, i) =>
    fastH[fastH.length - len + i] - slowH[slowH.length - len + i]
  );
  if (macdLine.length < signal) return null;
  const signalLine = emaHistory(macdLine, signal);
  const last = macdLine.length - 1;
  const sl = signalLine[signalLine.length - 1];
  const ml = macdLine[last];
  const prev = macdLine[last - 1];
  const psl = signalLine[signalLine.length - 2] ?? sl;
  return {
    macd: ml,
    signal: sl,
    histogram: ml - sl,
    crossUp: prev < psl && ml > sl,
    crossDown: prev > psl && ml < sl,
  };
}

export function bollingerBands(prices, period = 20, dev = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - sma) ** 2, 0) / period);
  const upper = sma + dev * std;
  const lower = sma - dev * std;
  const last = prices[prices.length - 1];
  return {
    upper, middle: sma, lower,
    bandwidth: (dev * 2 * std) / sma,
    pctB: (last - lower) / (upper - lower),
  };
}

export function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (tr.length < period) return null;
  let val = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) val = (val * (period - 1) + tr[i]) / period;
  return val;
}

export function volumeRatio(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return avg > 0 ? volumes[volumes.length - 1] / avg : null;
}

export function sma(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Detects if price is squeezing in a tight range (BB narrow)
export function isSqueezing(prices, period = 20, threshold = 0.015) {
  const bb = bollingerBands(prices, period);
  return bb !== null && bb.bandwidth < threshold;
}
