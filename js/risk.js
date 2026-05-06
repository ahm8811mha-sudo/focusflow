// ─── Risk Manager ─────────────────────────────────────────────────────────────
import { Config } from './config.js';
import { EventBus } from './events.js';

export const RiskManager = {
  sessionStartEquity: 0,
  currentEquity: 0,
  dailyPnL: 0,
  dailyTrades: 0,
  dailyLossHalt: false,
  openPositionCount: 0,

  reset(equity) {
    this.sessionStartEquity = equity;
    this.currentEquity = equity;
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.dailyLossHalt = false;
    this.openPositionCount = 0;
  },

  update(equity) {
    this.currentEquity = equity;
    this.dailyPnL = equity - this.sessionStartEquity;
    const lossLimit = this.sessionStartEquity * Config.get('dailyLossLimit');
    if (this.dailyPnL <= -lossLimit && !this.dailyLossHalt) {
      this.dailyLossHalt = true;
      EventBus.emit('risk:dailyLimitHit', { pnl: this.dailyPnL, limit: -lossLimit });
    }
  },

  canTrade() {
    if (this.dailyLossHalt) return { ok: false, reason: 'daily_loss_limit' };
    if (this.openPositionCount >= Config.get('maxPositions')) return { ok: false, reason: 'max_positions' };
    if (this.dailyTrades >= Config.get('maxDailyTrades')) return { ok: false, reason: 'max_daily_trades' };
    return { ok: true };
  },

  /**
   * Calculate how many shares to buy based on account equity & stop distance.
   * Risk = equity × riskPerTrade
   * Shares = Risk / (entry × stopLossPct)
   */
  positionSize(entry) {
    if (!this.currentEquity || !entry) return 1;
    const risk = this.currentEquity * Config.get('riskPerTrade');
    const stopDist = entry * Config.get('stopLossPct');
    if (stopDist <= 0) return 1;
    const shares = Math.floor(risk / stopDist);
    return Math.max(1, shares);
  },

  recordTrade(pnl) {
    this.dailyTrades++;
    this.dailyPnL += pnl;
    EventBus.emit('risk:tradeRecorded', { pnl, dailyPnL: this.dailyPnL, trades: this.dailyTrades });
  },

  setOpenPositions(count) {
    this.openPositionCount = count;
  },

  getDailyStats() {
    return {
      pnl: this.dailyPnL,
      pnlPct: this.sessionStartEquity
        ? (this.dailyPnL / this.sessionStartEquity) * 100 : 0,
      trades: this.dailyTrades,
      halted: this.dailyLossHalt,
      equity: this.currentEquity,
    };
  },
};
