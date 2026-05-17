// ─── UI Controller ────────────────────────────────────────────────────────────
import { EventBus }          from './events.js';
import { Config }            from './config.js';
import { PortfolioManager }  from './portfolio.js';
import { SuggestionsEngine } from './suggestions.js';
import { NewsScanner }       from './news.js';

const $ = id => document.getElementById(id);
const fmt  = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '--');
const fmtP = n => (typeof n === 'number' ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '--');
const fmtM = n => (typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) : '--');

export const UI = {
  signals:     {},   // symbol → latest signal
  lastPrices:  {},   // symbol → price
  allPositions: {},  // pid → positions array

  init() {
    this._bindEvents();
    this._bindControls();
    this._startClock();
    this._renderWatchlist();
    this._renderPortfolioSidebar();
    this._renderPortfolioSettings();
    this._renderMobileBar();
  },

  // ── EventBus subscriptions ─────────────────────────────────────────────────
  _bindEvents() {
    EventBus.on('engine:starting',    d => {
      this._setPortfolioStatus(d.pid, 'starting', '⏳ جارٍ البدء');
      this.addAlert(`⏳ بدء تشغيل "${d.name}"…`, 'info');
    });
    EventBus.on('engine:started',     d => {
      this._setPortfolioStatus(d.pid, 'running', '🟢 يعمل');
      this.addAlert(`✅ "${d.name}" بدأ التداول`, 'success');
      this._updateEngineHeader();
    });
    EventBus.on('engine:stopped',     d => {
      this._setPortfolioStatus(d.pid, 'stopped', '⛔ متوقف');
      this.addAlert(`⛔ "${d.name}" توقف`, 'info');
      this._updateEngineHeader();
    });
    EventBus.on('engine:marketClosed',d => this.addAlert('🔴 السوق أغلق – تم إيقاف المحفظة', 'warn'));
    EventBus.on('engine:eod',         d => this.addAlert(`⏱ ${d.minsLeft} دقيقة لإغلاق السوق – إغلاق المراكز`, 'warn'));
    EventBus.on('engine:allClosed',   ()  => this.addAlert('تم إغلاق جميع المراكز', 'info'));
    EventBus.on('engine:error',       d => this.addAlert('⚠️ ' + d.msg, 'error'));
    EventBus.on('engine:skipped',     d => this._setSubStatus(d.reason, d.pid));
    EventBus.on('broker:connected',   d => this.addAlert(`✅ اتصال ${d.market} ناجح`, 'success'));
    EventBus.on('broker:disconnected',d => this.addAlert(`🔌 انقطع اتصال ${d.market}`, 'warn'));
    EventBus.on('broker:error',       d => this.addAlert(`⚠️ ${d.market}: ${d.msg}`, 'error'));
    EventBus.on('account:update',     d => this._renderPortfolioMetrics(d));
    EventBus.on('positions:update',   d => {
      this.allPositions[d.pid] = Array.isArray(d.positions) ? d.positions : [];
      this._renderPositions();
    });
    EventBus.on('trade:placed',       d => this._renderTrade(d));
    EventBus.on('price:update',       d => this._updatePrice(d.symbol, d.bar.c));
    EventBus.on('signal:analyzed',    d => this._updateSignal(d));
    EventBus.on('risk:dailyLimitHit', d => this.addAlert(`🛑 وصل الحد اليومي للخسارة: ${fmtM(d.pnl)}`, 'error'));
  },

  // ── Controls ───────────────────────────────────────────────────────────────
  _bindControls() {
    $('btn-stop-all')?.addEventListener('click', () => {
      if (!confirm('إيقاف جميع المحافظ؟')) return;
      PortfolioManager.stopAll();
    });

    // Tab switching
    ['positions','signals','suggestions','log','news','settings'].forEach(t => {
      $(`tab-${t}`)?.addEventListener('click', () => this._switchTab(t));
    });

    // Settings save
    $('settings-save')?.addEventListener('click', () => this._saveSettings());

    // Add portfolio buttons
    $('settings-add-us')?.addEventListener('click', () => {
      Config.addPortfolio('US');
      this._renderPortfolioSidebar();
      this._renderPortfolioSettings();
      this._renderMobileBar();
    });
    $('settings-add-sa')?.addEventListener('click', () => {
      Config.addPortfolio('SA');
      this._renderPortfolioSidebar();
      this._renderPortfolioSettings();
      this._renderMobileBar();
    });

    // Suggestions scan button
    $('btn-scan-suggestions')?.addEventListener('click', () => this._runSuggestions());
  },

  // ── Tab management ─────────────────────────────────────────────────────────
  _switchTab(tab) {
    ['positions','signals','suggestions','log','news','settings'].forEach(t => {
      $(`tab-${t}`)?.classList.toggle('active', t === tab);
      $(`panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    if (tab === 'news') this._renderNews();
  },

  // ── Engine status header ───────────────────────────────────────────────────
  _updateEngineHeader() {
    const portfolios = Config.getPortfolios();
    const running = portfolios.filter(p => PortfolioManager.isRunning(p.id));
    const el = $('engine-status');
    if (!el) return;
    if (running.length === 0) {
      el.textContent = '⛔ متوقف';
      el.className = 'engine-status stopped';
    } else {
      el.textContent = `🟢 يعمل (${running.length} محفظة)`;
      el.className = 'engine-status running';
    }
  },

  _setSubStatus(reason) {
    const map = {
      daily_loss_limit: 'حد الخسارة اليومية',
      max_positions:    'حد المراكز المفتوحة',
      max_daily_trades: 'حد الصفقات اليومية',
    };
    const el = $('sub-status');
    if (el) el.textContent = map[reason] || reason;
  },

  // ── Portfolio sidebar ──────────────────────────────────────────────────────
  _renderPortfolioSidebar() {
    const container = $('portfolio-list');
    if (!container) return;
    const portfolios = Config.getPortfolios();
    container.innerHTML = portfolios.map(p => {
      const flag = p.market === 'US' ? '🇺🇸' : '🇸🇦';
      const configured = Config.isPortfolioConfigured(p);
      return `
        <div class="port-card" id="portcard-${p.id}">
          <div class="port-card-top">
            <span class="port-name">${flag} ${p.name}</span>
            <span class="port-status stopped" id="portstatus-${p.id}">⛔ متوقف</span>
          </div>
          <div class="port-metrics">
            <span id="portequity-${p.id}" class="port-equity">--</span>
            <span id="portpnl-${p.id}" class="port-pnl">--</span>
          </div>
          <div class="port-card-actions">
            <button class="btn btn-green btn-sm port-start" data-pid="${p.id}" ${!configured ? 'disabled title="أكمل بيانات API في الإعدادات"' : ''}>▶ بدء</button>
            <button class="btn btn-red btn-sm port-stop" data-pid="${p.id}">■ إيقاف</button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.port-start').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.pid;
        if (!PortfolioManager.start(pid)) {
          this.addAlert('تحقق من بيانات API في الإعدادات', 'warn');
        }
      });
    });
    container.querySelectorAll('.port-stop').forEach(btn => {
      btn.addEventListener('click', () => PortfolioManager.stop(btn.dataset.pid));
    });
  },

  _setPortfolioStatus(pid, state, text) {
    const el = $(`portstatus-${pid}`);
    if (el) { el.textContent = text; el.className = `port-status ${state}`; }
    const startBtn = document.querySelector(`[data-pid="${pid}"].port-start`);
    const stopBtn  = document.querySelector(`[data-pid="${pid}"].port-stop`);
    if (startBtn) startBtn.disabled = (state === 'running' || state === 'starting');
    if (stopBtn)  stopBtn.disabled  = (state === 'stopped');
    this._renderMobileBar();
  },

  _renderMobileBar() {
    const bar = $('mobile-bar');
    if (!bar) return;
    const portfolios = Config.getPortfolios();
    bar.innerHTML = portfolios.map(p => {
      const running = PortfolioManager.isRunning(p.id);
      const flag    = p.market === 'US' ? '🇺🇸' : '🇸🇦';
      const label   = running ? 'إيقاف' : 'بدء';
      return `<div class="mobile-port-chip ${running ? 'running' : 'stopped'}" data-pid="${p.id}">
        <span class="chip-dot"></span>${flag} ${p.name} · ${label}
      </div>`;
    }).join('') + `<div class="mobile-port-chip" id="mobile-settings-btn" style="border-color:var(--blue);color:var(--blue)">⚙️ إعدادات</div>`;

    bar.querySelectorAll('.mobile-port-chip[data-pid]').forEach(chip => {
      chip.addEventListener('click', () => {
        const pid = chip.dataset.pid;
        if (PortfolioManager.isRunning(pid)) PortfolioManager.stop(pid);
        else {
          if (!PortfolioManager.start(pid)) this.addAlert('تحقق من بيانات API في الإعدادات', 'warn');
        }
      });
    });
    $('mobile-settings-btn')?.addEventListener('click', () => this._switchTab('settings'));
  },

  _renderPortfolioMetrics(acct) {
    const pid = acct.pid;
    if (!pid) return;
    const eq  = parseFloat(acct.equity || acct.portfolio_value || 0);
    const eqEl = $(`portequity-${pid}`);
    if (eqEl) eqEl.textContent = '$' + eq.toLocaleString('en', { minimumFractionDigits: 2 });
    const stats = PortfolioManager.getRiskStats(pid);
    const pnlEl = $(`portpnl-${pid}`);
    if (pnlEl && stats) {
      pnlEl.textContent = fmtM(stats.pnl) + ' (' + fmtP(stats.pnlPct) + ')';
      pnlEl.className = 'port-pnl ' + (stats.pnl >= 0 ? 'green' : 'red');
    }
    // Aggregate totals
    this._renderTotals();
  },

  _renderTotals() {
    let totalPnl = 0, totalTrades = 0;
    Config.getPortfolios().forEach(p => {
      const s = PortfolioManager.getRiskStats(p.id);
      if (s) { totalPnl += s.pnl; totalTrades += s.trades; }
    });
    const tpEl = $('total-pnl');
    if (tpEl) {
      tpEl.textContent = fmtM(totalPnl);
      tpEl.className = 'metric-value ' + (totalPnl >= 0 ? 'green' : 'red');
    }
    const ttEl = $('total-trades');
    if (ttEl) ttEl.textContent = totalTrades;
  },

  // ── Positions ──────────────────────────────────────────────────────────────
  _renderPositions() {
    const all = Object.values(this.allPositions).flat();
    const tbody = $('positions-tbody');
    if (!tbody) return;
    if (!all.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">لا توجد مراكز مفتوحة</td></tr>';
      $('pos-count').textContent = '0';
      return;
    }
    tbody.innerHTML = all.map(p => {
      const pl    = parseFloat(p.unrealized_pl || 0);
      const plPct = parseFloat(p.unrealized_plpc || 0) * 100;
      const side  = p.side === 'long' ? 'شراء' : 'بيع';
      return `<tr>
        <td><strong>${p.symbol}</strong></td>
        <td class="num">${p.qty}</td>
        <td class="num">$${parseFloat(p.avg_entry_price || 0).toFixed(3)}</td>
        <td class="num">$${parseFloat(p.current_price || 0).toFixed(3)}</td>
        <td class="num ${pl >= 0 ? 'green' : 'red'}">${fmtM(pl)}</td>
        <td class="num ${pl >= 0 ? 'green' : 'red'}">${fmtP(plPct)}</td>
        <td><span class="side-badge ${p.side}">${side}</span></td>
        <td class="num" style="font-size:10px;color:var(--text2)">${p._pid || ''}</td>
      </tr>`;
    }).join('');
    $('pos-count').textContent = all.length;
  },

  // ── Trade log ──────────────────────────────────────────────────────────────
  _renderTrade(trade) {
    const tbody = $('log-tbody');
    if (!tbody) return;
    const sideAr = trade.side === 'buy' ? 'شراء' : 'بيع';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${trade.timestamp.toLocaleTimeString('ar-SA')}</td>
      <td>${trade.market}</td>
      <td><strong>${trade.symbol}</strong></td>
      <td style="font-size:11px;color:var(--text2)">${trade.portfolioName || ''}</td>
      <td><span class="side-badge ${trade.side}">${sideAr}</span></td>
      <td class="num">${trade.qty}</td>
      <td class="num">$${trade.entry.toFixed(3)}</td>
      <td class="num green">$${trade.tp.toFixed(3)}</td>
      <td class="num red">$${trade.sl.toFixed(3)}</td>
      <td><span class="status-badge">${trade.status}</span></td>`;
    tbody.prepend(row);
    if (tbody.children.length > 100) tbody.lastElementChild?.remove();
  },

  // ── Price / Signal ─────────────────────────────────────────────────────────
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
      .filter(([, s]) => s.signal !== 0)
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
        <div class="sig-price">$${(s.entry || 0).toFixed(3)}</div>
        <div class="sig-reason">${s.reason || ''}</div>
        <div class="sig-vol">تذبذب: ${((s.volatility || 0) * 100).toFixed(3)}%</div>
      </div>`;
    }).join('');
  },

  // ── Suggestions ───────────────────────────────────────────────────────────
  async _runSuggestions() {
    const btn = $('btn-scan-suggestions');
    const grid = $('suggestions-grid');
    if (!grid) return;
    grid.innerHTML = '<p class="empty">⏳ جارٍ التحليل… قد يستغرق دقيقة</p>';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ جارٍ التحليل…'; }
    const results = await SuggestionsEngine.scan();
    if (btn) { btn.disabled = false; btn.textContent = '🔍 تحليل الآن'; }
    const lastScanEl = $('suggestions-last-scan');
    if (lastScanEl && SuggestionsEngine.lastScan) {
      lastScanEl.textContent = 'آخر تحديث: ' + SuggestionsEngine.lastScan.toLocaleTimeString('ar-SA');
    }
    if (!results.length) {
      grid.innerHTML = '<p class="empty">لا توجد بيانات – تحقق من مفاتيح API في الإعدادات</p>';
      return;
    }
    grid.innerHTML = results.map(r => {
      const signalClass = r.signal === 1 ? 'buy' : r.signal === -1 ? 'sell' : 'neutral';
      const signalAr    = r.signal === 1 ? '🟢 شراء' : r.signal === -1 ? '🔴 بيع' : '⚪ محايد';
      const flag        = r.market === 'US' ? '🇺🇸' : '🇸🇦';
      const rsiVal      = r.rsiVal != null ? r.rsiVal.toFixed(1) : '--';
      const bbPct       = r.bbVal  != null ? (r.bbVal.pctB * 100).toFixed(1) + '%' : '--';
      const vol         = r.volatility != null ? (r.volatility * 100).toFixed(3) + '%' : '--';
      return `<div class="sugg-card ${signalClass}">
        <div class="sugg-header">
          <span class="sugg-sym">${r.symbol}</span>
          <span class="sugg-market">${flag}</span>
          <span class="sugg-signal-badge ${signalClass}">${signalAr}</span>
        </div>
        <div class="sugg-score-row">
          <div class="sugg-score-bar"><div class="sugg-score-fill" style="width:${r.score}%"></div></div>
          <span class="sugg-score-num">${r.score}</span>
        </div>
        <div class="sugg-indicators">
          <span>RSI: ${rsiVal}</span>
          <span>BB%: ${bbPct}</span>
          <span>تذبذب: ${vol}</span>
        </div>
        ${r.reason && r.signal !== 0 ? `<div class="sugg-reason">${r.reason}</div>` : ''}
      </div>`;
    }).join('');
  },

  // ── News ──────────────────────────────────────────────────────────────────
  _renderNews() {
    const feed = $('news-feed');
    if (!feed) return;
    const news = NewsScanner.getRecentNews(20);
    if (!news.length) {
      feed.innerHTML = '<p class="empty">ابدأ التداول لتحميل الأخبار</p>';
      return;
    }
    feed.innerHTML = news.map(n => `
      <div class="news-item ${n.impact === 'high' ? 'news-high' : ''}">
        <div class="news-time">${n.createdAt.toLocaleTimeString('ar-SA')}</div>
        <div class="news-headline">${n.headline}</div>
        ${n.symbols.length ? `<div class="news-syms">${n.symbols.join(' · ')}</div>` : ''}
      </div>`).join('');
  },

  // ── Watchlist ─────────────────────────────────────────────────────────────
  _renderWatchlist() {
    const buildList = list => list.map(s => `
      <div class="wl-item" data-sym="${s}">
        <span class="wl-sym">${s}</span>
        <span class="price">--</span>
      </div>`).join('');
    const usEl = $('watchlist-us');
    if (usEl) usEl.innerHTML = buildList(Config.get('usWatchlist'));
    const saEl = $('watchlist-sa');
    if (saEl) saEl.innerHTML = buildList(Config.get('saWatchlist'));
  },

  // ── Alerts ────────────────────────────────────────────────────────────────
  addAlert(msg, type = 'info') {
    const feed = $('alert-feed');
    if (!feed) return;
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<span class="alert-time">${new Date().toLocaleTimeString('ar-SA')}</span> ${msg}`;
    feed.prepend(el);
    if (feed.children.length > 50) feed.lastElementChild?.remove();
  },

  // ── Settings tab ──────────────────────────────────────────────────────────
  _renderPortfolioSettings() {
    const container = $('portfolio-settings-list');
    if (!container) return;
    const portfolios = Config.getPortfolios();

    container.innerHTML = portfolios.map(p => {
      const flag = p.market === 'US' ? '🇺🇸' : '🇸🇦';
      const usFields = `
        <div class="field">
          <label>وضع التداول</label>
          <select class="pf-mode">
            <option value="paper" ${p.mode !== 'live' ? 'selected' : ''}>ورقي (تجريبي)</option>
            <option value="live"  ${p.mode === 'live'  ? 'selected' : ''}>حقيقي (Live)</option>
          </select>
        </div>
        <div class="field">
          <label>API Key ID</label>
          <input type="password" class="pf-key" value="${p.key || ''}" placeholder="APCA-API-KEY-ID"/>
        </div>
        <div class="field">
          <label>API Secret Key</label>
          <input type="password" class="pf-secret" value="${p.secret || ''}" placeholder="APCA-API-SECRET-KEY"/>
        </div>`;
      const saFields = `
        <div class="field settings-full">
          <label>رابط API</label>
          <input class="pf-baseurl" value="${p.baseUrl || ''}" placeholder="https://api.broker.com.sa"/>
        </div>
        <div class="field">
          <label>API Key</label>
          <input type="password" class="pf-key" value="${p.key || ''}" placeholder="مفتاح API"/>
        </div>
        <div class="field">
          <label>API Secret</label>
          <input type="password" class="pf-secret" value="${p.secret || ''}" placeholder="كلمة السر"/>
        </div>`;
      return `
        <div class="pf-edit" data-pid="${p.id}">
          <div class="pf-edit-header">
            <button class="pf-toggle-btn">${flag} ${p.name} ▼</button>
            <button class="pf-delete-btn btn btn-gray btn-sm" data-pid="${p.id}" style="width:auto;padding:3px 8px">🗑</button>
          </div>
          <div class="pf-edit-body hidden settings-grid">
            <div class="field">
              <label>اسم المحفظة</label>
              <input class="pf-name" value="${p.name}"/>
            </div>
            <div class="field" style="visibility:hidden"></div>
            ${p.market === 'US' ? usFields : saFields}
          </div>
        </div>`;
    }).join('');

    // Toggle expand/collapse
    container.querySelectorAll('.pf-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const body = btn.closest('.pf-edit').querySelector('.pf-edit-body');
        body?.classList.toggle('hidden');
      });
    });

    // Delete portfolio
    container.querySelectorAll('.pf-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const pid = btn.dataset.pid;
        const p   = Config.getPortfolio(pid);
        if (!p) return;
        if (!confirm(`حذف "${p.name}"؟`)) return;
        PortfolioManager.stop(pid);
        Config.deletePortfolio(pid);
        this._renderPortfolioSidebar();
        this._renderPortfolioSettings();
      });
    });
  },

  _saveSettings() {
    // Save portfolio credentials from expanded forms
    document.querySelectorAll('.pf-edit').forEach(card => {
      const pid = card.dataset.pid;
      const p   = Config.getPortfolio(pid);
      if (!p) return;
      const name    = card.querySelector('.pf-name')?.value?.trim();
      const key     = card.querySelector('.pf-key')?.value?.trim();
      const secret  = card.querySelector('.pf-secret')?.value?.trim();
      const mode    = card.querySelector('.pf-mode')?.value;
      const baseUrl = card.querySelector('.pf-baseurl')?.value?.trim();
      Config.savePortfolio({ ...p, name: name || p.name, key: key ?? p.key, secret: secret ?? p.secret, ...(mode ? { mode } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) });
    });

    // Strategy
    const pctFields = ['takeProfitPct','stopLossPct','riskPerTrade','dailyLossLimit'];
    const intFields = ['maxPositions','maxDailyTrades','scanIntervalSec','closeMinutesBeforeEnd','rsiOversold','rsiOverbought'];
    const strFields = ['finnhubKey','alphaVantageKey'];
    const obj = {};
    for (const f of pctFields) {
      const el = $('cfg-' + f);
      if (el && el.value) obj[f] = parseFloat(el.value) / 100;
    }
    for (const f of intFields) {
      const el = $('cfg-' + f);
      if (el && el.value) obj[f] = parseInt(el.value, 10);
    }
    for (const f of strFields) {
      const el = $('cfg-' + f);
      if (el) obj[f] = el.value.trim();
    }
    Config.setMany(obj);
    this._renderPortfolioSidebar();
    this._renderWatchlist();
    this._renderMobileBar();
    this.addAlert('✅ تم حفظ الإعدادات', 'success');
  },

  _loadSettingsForm() {
    const fields = ['takeProfitPct','stopLossPct','rsiOversold','rsiOverbought',
                    'riskPerTrade','maxPositions','dailyLossLimit','maxDailyTrades',
                    'scanIntervalSec','closeMinutesBeforeEnd','finnhubKey','alphaVantageKey'];
    for (const f of fields) {
      const el = $('cfg-' + f);
      if (!el) continue;
      const v = Config.get(f);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = typeof v === 'number' && (f.endsWith('Pct') || f.endsWith('Limit'))
        ? (v * 100).toFixed(2) : v;
    }
  },

  // ── Clock ─────────────────────────────────────────────────────────────────
  _startClock() {
    const update = () => {
      const el  = $('clock');
      if (!el) return;
      const now = new Date();
      const et  = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
      const sa  = now.toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh', hour12: false });
      el.textContent = `🇺🇸 ${et} ET  |  🇸🇦 ${sa} AST`;
    };
    update();
    setInterval(update, 1000);
    this._loadSettingsForm();
  },
};
