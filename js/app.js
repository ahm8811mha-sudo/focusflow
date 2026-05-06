// ─── Application Entry Point ──────────────────────────────────────────────────
import { Config }  from './config.js';
import { UI }      from './ui.js';
import { Engine }  from './engine.js';
import { EventBus } from './events.js';

Config.load();
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  UI.addAlert('مرحباً بك في نظام التداول الآلي', 'info');
  UI.addAlert('أدخل بيانات API ثم اضغط "بدء التداول"', 'info');

  // Auto-start if configured and market is open
  const market = Config.get('activeMarket');
  if (market !== 'BOTH' && Config.isConfigured(market)) {
    const { AlpacaBroker } = window.__brokers || {};
    // Defer to let UI settle
    setTimeout(async () => {
      const importedAlpaca = await import('./broker/alpaca.js');
      if (market === 'US' && importedAlpaca.AlpacaBroker.isMarketOpen()) {
        UI.addAlert('السوق مفتوح – بدء التداول تلقائياً', 'success');
        Engine.start('US');
      } else {
        const importedSaudi = await import('./broker/saudi.js');
        if (market === 'SA' && importedSaudi.SaudiBroker.isMarketOpen()) {
          UI.addAlert('السوق السعودي مفتوح – بدء التداول', 'success');
          Engine.start('SA');
        }
      }
    }, 1000);
  }

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
});
