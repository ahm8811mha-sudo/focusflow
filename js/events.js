// ─── Simple Event Bus ─────────────────────────────────────────────────────────
export const EventBus = {
  _handlers: {},

  on(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(fn);
    return () => this.off(event, fn);
  },

  off(event, fn) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== fn);
  },

  emit(event, data) {
    (this._handlers[event] || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error(`EventBus[${event}]`, e); }
    });
  },
};
