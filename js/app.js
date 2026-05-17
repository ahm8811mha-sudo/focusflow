// ─── Application Entry Point ──────────────────────────────────────────────────
import { Config }           from './config.js';
import { UI }               from './ui.js';
import { PortfolioManager } from './portfolio.js';
import { EventBus }         from './events.js';

Config.load();
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  UI.addAlert('مرحباً بك في نظام التداول الآلي', 'info');
  UI.addAlert('أضف بيانات API في تبويب الإعدادات ثم ابدأ التداول', 'info');

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
});
