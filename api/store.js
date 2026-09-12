// In-memory fallback store for reports by PIN with auto-expiry and GETDEL (atomic burn after reading)
const store = new Map();

function cleanExpired() {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (val.expiresAt <= now) {
      store.delete(key);
    }
  }
}

// Check expired items every 15 seconds
const cleanupTimer = setInterval(cleanExpired, 15000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  savePin(pin, report, ttlSeconds = 600) {
    cleanExpired();
    store.set(`pin:${pin}`, {
      report,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  },

  getDelPin(pin) {
    cleanExpired();
    const key = `pin:${pin}`;
    const item = store.get(key);
    if (!item) return null;
    store.delete(key); // Atomic GETDEL
    if (item.expiresAt <= Date.now()) {
      return null;
    }
    return item.report;
  },

  hasPin(pin) {
    const key = `pin:${pin}`;
    const item = store.get(key);
    return !!(item && item.expiresAt > Date.now());
  }
};
