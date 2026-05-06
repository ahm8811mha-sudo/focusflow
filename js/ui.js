// ─── UI Controller ────────────────────────────────────────────────────────────
import { EventBus }    from './events.js';
import { RiskManager } from './risk.js';
import { Engine }      from './engine.js';
import { Config }      from './config.js';

const $ = id => document.getElementById(id);
const fmt  = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '--');
const fmtP = (n)         => (typeof n === 'number' ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '--');
const fmtM = (n)         => (typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) : '--');

export const UI = {
  signals: {},       // symbol → latest signal
  lastPrices: {},    // symbol → price
  positions: [],
  account: null,

  init() {
    this._bindEvents();
    this._bindControls();
    this._startClock();
    this._renderWatchlist();
  },

  _bindEvents() {
    EventBus.on('engine:started',     d => this._setStatus('running',  `🟢 يعمل – سوق ${d.market}`));
    EventBus.on('engine:stopped',     ()  => this._setStatus('stopped', '⛔ متوقف'));
    EventBus.on('engine:starting',    d => this._setStatus('starting', `⏳ جارٍ البدء – ${d.market}`));
    EventBus.on('engine:marketClosed',()  => this._setStatus('closed',  '🔴 السوق مغلق'));
    EventBus.on('engine:eod',         d => this.addAlert(`⏱ ${d.minsLeft} دقيقة لإغلاق السوق – إغلاق المراكز`, 'warn'));
    EventBus.on('engine:allClosed',   ()  => this.addAlert('تم إغلاق جميع المراكز قبل نهاية الجلسة', 'info'));
    EventBus.on('engine:error',       d => this.addAlert('⚠️ ' + d.msg, 'error'));
    EventBus.on('engine:skipped',     d => this._setSubStatus(d.reason));
    EventBus.on('broker:connected',   d => this.addAlert(`✅ اتصال ${d.market} ناجح`, 'success'));
    EventBus.on('broker:disconnected',d => this.addAlert(`🔌 انقطع اتصال ${d.market}`, 'warn'));
    EventBus.on('broker:error',       d => this.addAlert(`⚠️ ${d.market}: ${d.msg}`, 'error'));
    EventBus.on('account:update',     d => this._renderAccount(d));
    EventBus.on('positions:update',   d => this._renderPositions(d));
    EventBus.on('trade:placed',       d => this._renderTrade(d));
    EventBus.on('price:update',       d => this._updatePrice(d.symbol, d.bar.c));
    EventBus.on('signal:analyzed',    d => this._updateSignal(d));
    EventBus.on('risk:dailyLimitHit', d => this.addAlert(`🛑 وصل الحد اليومي للخسارة: ${fmtM(d.pnl)}`, 'error'));
  },

  _bindControls() {
    $('btn-start-us')?.addEventListener('click', () => {
      if (!Config.isConfigured('US')) { this.showSettings(); return; }
      Engine.start('US');
    });
    $('btn-start-sa')?.addEventListener('click', () => {
      if (!Config.isConfigured('SA')) { this.showSettings(); return; }
      Engine.start('SA');
    });
    $('btn-stop')?.addEventListener('click', () => Engine.stop());
    $('btn-close-all')?.addEventListener('click', async () => {
      if (!confirm('إغلاق جميع المراكز؟')) return;
      Engine.market === 'SA'
        ? await (await import('./broker/saudi.js')).SaudiBroker.closeAllPositions?.()
        : await (await import('./broker/alpaca.js')).AlpacaBroker.closeAllPositions();
    });
    $('btn-settings')?.addEventListener('click', () => this.toggleSettings());
    $('settings-save')?.addEventListener('click', () => this._saveSettings());
    $('settings-cancel')?.addEventListener('click', () => this.hideSettings());
    $('tab-positions')?.addEventListener('click', () => this._switchTab('positions'));
    $('tab-signals')?.addEventListener('click',   () => this._switchTab('signals'));
    $('tab-log')?.addEventListener('click',       () => this._switchTab('log'));
    $('tab-news')?.addEventListener('click',      () => this._switchTab('news'));
    // load settings into form
    this._loadSettingsForm();
  },

  _switchTab(tab) {
    ['positions','signals','log','news'].forEach(t => {
      $(`tab-${t}`)?.classList.toggle('active', t === tab);
      $(`panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
  },

  _setStatus(state, text) {
    const el = $('engine-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'engine-status ' + state;
  },

  _setSubStatus(reason) {
    const map = {
      daily_loss_limit: 'حد الخسارة اليومية',
      max_positions: 'حد المراكز المفتوحة',
      max_daily_trades: 'حد الصفقات اليومية',
    };
    const el = $('sub-status');
    if (el) el.textContent = map[reason] || reason;
  },

  _renderAccount(acct) {
    this.account = acct;
    const equity  = parseFloat(acct.equity || acct.portfolio_value || 0);
    const cash    = parseFloat(acct.cash || 0);
    const pnl     = parseFloat(acct.unrealized_pl || 0);
    const pnlPct  = equity ? (pnl / equity) * 100 : 0;
    const setEl = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    setEl('acct-equity', '$' + equity.toLocaleString('en', { minimumFractionDigits: 2 }));
    setEl('acct-cash',   '$' + cash.toLocaleString('en', { minimumFractionDigits: 2 }));
    const pnlEl = $('acct-pnl');
    if (pnlEl) {
      pnlEl.textContent = fmtM(pnl) + ' (' + fmtP(pnlPct) + ')';
      pnlEl.className = 'metric-value ' + (pnl >= 0 ? 'green' : 'red');
    }
    const stats = RiskManager.getDailyStats();
    const dpEl = $('daily-pnl');
    if (dpEl) {
      dpEl.textContent = fmtM(stats.pnl) + ' (' + fmtP(stats.pnlPct) + ')';
      dpEl.className = 'metric-value ' + (stats.pnl >= 0 ? 'green' : 'red');
    }
    const tEl = $('daily-trades');
    if (tEl) tEl.textContent = stats.trades + ' / ' + Config.get('maxDailyTrades');
  },

  _renderPositions(positions) {
    this.positions = Array.isArray(positions) ? positions : [];
    const tbody = $('positions-tbody');
    if (!tbody) return;
    if (!this.positions.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">لا توجد مراكز مفتوحة</td></tr>';
      return;
    }
    tbody.innerHTML = this.positions.map(p => {
      const pl = parseFloat(p.unrealized_pl || 0);
      const plPct = parseFloat(p.unrealized_plpc || 0) * 100;
      const side = p.side === 'long' ? 'شراء' : 'بيع';
      return `<tr>
        <td><strong>${p.symbol}</strong></td>
        <td class="num">${p.qty}</td>
        <td class="num">$${parseFloat(p.avg_entry_price || 0).toFixed(3)}</td>
        <td class="num">$${parseFloat(p.current_price || 0).toFixed(3)}</td>
        <td class="num ${pl >= 0 ? 'green' : 'red'}">${fmtM(pl)}</td>
        <td class="num ${pl >= 0 ? 'green' : 'red'}">${fmtP(plPct)}</td>
        <td><span class="side-badge ${p.side}">${side}</span></td>
      </tr>`;
    }).join('');
    $('pos-count').textContent = this.positions.length;
  },

  _renderTrade(trade) {
    const tbody = $('log-tbody');
    if (!tbody) return;
    const sideAr = trade.side === 'buy' ? 'شراء' : 'بيع';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${trade.timestamp.toLocaleTimeString('ar-SA')}</td>
      <td>${trade.market}</td>
      <td><strong>${trade.symbol}</strong></td>
      <td><span class="side-badge ${trade.side}">${sideAr}</span></td>
      <td class="num">${trade.qty}</td>
      <td class="num">$${trade.entry.toFixed(3)}</td>
      <td class="num green">$${trade.tp.toFixed(3)}</td>
      <td class="num red">$${trade.sl.toFixed(3)}</td>
      <td><span class="status-badge">${trade.status}</span></td>
    `;
    tbody.prepend(row);
    if (tbody.children.length > 100) tbody.lastElementChild?.remove();
  },

  _updatePrice(symbol, price) {
    this.lastPrices[symbol] = price;
    const el = document.querySelector(`[data-sym="${symbol}"] .price`);
    if (el) el.textContent = '$' + price.toFixed(3);
  },

  _updateSignal(data) {
    this.signals[data.symbol] = data;
    const sigPanel = $('panel-signals');
    if (!sigPanel || sigPanel.classList.contains('hidden')) return;
    this._renderSignalsPanel();
  },

  _renderSignalsPanel() {
    const container = $('signals-grid');
    if (!container) return;
    const entries = Object.entries(this.signals)
      .filter(([,s]) => s.signal !== 0)
      .sort((a, b) => Math.abs(b[1].signal) - Math.abs(a[1].signal))
      .slice(0, 20);
    if (!entries.length) {
      container.innerHTML = '<p class="empty">لا توجد إشارات حالياً</p>';
      return;
    }
    container.innerHTML = entries.map(([sym, s]) => {
      const typeAr = s.signal === 1 ? 'شراء' : 'بيع';
      const cls    = s.signal === 1 ? 'buy' : 'sell';
      return `<div class="signal-card ${cls}">
        <div class="sig-sym">${sym}</div>
        <div class="sig-type">${typeAr}</div>
        <div class="sig-price">$${(s.entry||0).toFixed(3)}</div>
        <div class="sig-reason">${s.reason||''}</div>
        <div class="sig-vol">تذبذب: ${((s.volatility||0)*100).toFixed(3)}%</div>
      </div>`;
    }).join('');
  },

  _renderWatchlist() {
    const us = Config.get('usWatchlist');
    const sa = Config.get('saWatchlist');
    const buildList = (list, market) => list.map(s => `
      <div class="wl-item" data-sym="${s}">
        <span class="wl-sym">${s}</span>
        <span class="price">--</span>
      </div>`).join('');
    const usEl = $('watchlist-us');
    if (usEl) usEl.innerHTML = buildList(us, 'US');
    const saEl = $('watchlist-sa');
    if (saEl) saEl.innerHTML = buildList(sa, 'SA');
  },

  addAlert(msg, type = 'info') {
    const feed = $('alert-feed');
    if (!feed) return;
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<span class="alert-time">${new Date().toLocaleTimeString('ar-SA')}</span> ${msg}`;
    feed.prepend(el);
    if (feed.children.length > 50) feed.lastElementChild?.remove();
  },

  showSettings() {
    $('settings-modal')?.classList.remove('hidden');
  },

  hideSettings() {
    $('settings-modal')?.classList.add('hidden');
  },

  toggleSettings() {
    $('settings-modal')?.classList.toggle('hidden');
  },

  _loadSettingsForm() {
    const fields = [
      'alpacaMode','alpacaKey','alpacaSecret',
      'saudiBaseUrl','saudiKey','saudiSecret',
      'finnhubKey','alphaVantageKey',
      'takeProfitPct','stopLossPct','rsiOversold','rsiOverbought',
      'riskPerTrade','maxPositions','dailyLossLimit','maxDailyTrades',
      'scanIntervalSec','closeMinutesBeforeEnd',
    ];
    for (const f of fields) {
      const el = $('cfg-' + f);
      if (!el) continue;
      const v = Config.get(f);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = typeof v === 'number' && f.endsWith('Pct') || f.endsWith('Limit')
        ? (v * 100).toFixed(2) : v;
    }
  },

  _saveSettings() {
    const pctFields = ['takeProfitPct','stopLossPct','riskPerTrade','dailyLossLimit'];
    const intFields = ['maxPositions','maxDailyTrades','scanIntervalSec','closeMinutesBeforeEnd',
                       'rsiOversold','rsiOverbought'];
    const strFields = ['alpacaMode','alpacaKey','alpacaSecret','saudiBaseUrl','saudiKey',
                       'saudiSecret','finnhubKey','alphaVantageKey'];
    const obj = {};
    for (const f of pctFields) {
      const el = $('cfg-' + f);
      if (el) obj[f] = parseFloat(el.value) / 100;
    }
    for (const f of intFields) {
      const el = $('cfg-' + f);
      if (el) obj[f] = parseInt(el.value, 10);
    }
    for (const f of strFields) {
      const el = $('cfg-' + f);
      if (el) obj[f] = el.value.trim();
    }
    Config.setMany(obj);
    this.hideSettings();
    this.addAlert('✅ تم حفظ الإعدادات', 'success');
    this._renderWatchlist();
  },

  _startClock() {
    const update = () => {
      const el = $('clock');
      if (!el) return;
      const now = new Date();
      const etStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
      const saStr = now.toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh', hour12: false });
      el.textContent = `🇺🇸 ${etStr} ET  |  🇸🇦 ${saStr} AST`;
    };
    update();
    setInterval(update, 1000);
  },
};
