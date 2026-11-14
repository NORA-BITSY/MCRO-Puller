import fs from 'node:fs';
import path from 'node:path';

export class ProxyManager {
  constructor(options = {}) {
    this.proxies = [];
    this.currentIndex = 0;
    this.quarantineTimeMs = options.quarantineTimeMs || 15 * 60 * 1000; // 15 mins
    this.loadFromSources(options);
  }

  loadFromSources(options) {
    if (options.proxyList && Array.isArray(options.proxyList)) {
      this.proxies = options.proxyList.map((p) => this.parseProxy(p)).filter(Boolean);
    } else if (options.proxyFile && fs.existsSync(options.proxyFile)) {
      this.loadFromFile(options.proxyFile);
    } else if (process.env.MCRO_PROXIES) {
      this.proxies = process.env.MCRO_PROXIES.split(/[,\n]/)
        .map((p) => this.parseProxy(p))
        .filter(Boolean);
    }
  }

  loadFromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (filePath.endsWith('.json')) {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data.proxies || [];
      this.proxies = list.map((p) => this.parseProxy(p)).filter(Boolean);
    } else {
      this.proxies = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((p) => this.parseProxy(p))
        .filter(Boolean);
    }
    console.log(`[ProxyManager] Loaded ${this.proxies.length} proxy/proxies from ${filePath}`);
  }

  parseProxy(strOrObj) {
    if (!strOrObj) return null;
    if (typeof strOrObj === 'object' && strOrObj.server) {
      return {
        raw: strOrObj.server,
        server: strOrObj.server,
        username: strOrObj.username || '',
        password: strOrObj.password || '',
        failures: 0,
        successes: 0,
        quarantinedUntil: 0,
      };
    }

    const str = String(strOrObj).trim();
    try {
      let urlStr = str;
      if (!str.startsWith('http://') && !str.startsWith('https://') && !str.startsWith('socks5://')) {
        urlStr = 'http://' + str;
      }
      const parsed = new URL(urlStr);
      return {
        raw: str,
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        failures: 0,
        successes: 0,
        quarantinedUntil: 0,
      };
    } catch (e) {
      console.warn(`[ProxyManager] Failed to parse proxy string: "${str}"`);
      return null;
    }
  }

  getNextAvailableProxy() {
    if (this.proxies.length === 0) return null;

    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.currentIndex + i) % this.proxies.length;
      const candidate = this.proxies[idx];

      if (candidate.quarantinedUntil > now) {
        continue; // Still quarantined
      }

      this.currentIndex = (idx + 1) % this.proxies.length;
      return candidate;
    }

    // All are quarantined - pick the one with earliest expiration
    const sorted = [...this.proxies].sort((a, b) => a.quarantinedUntil - b.quarantinedUntil);
    return sorted[0];
  }

  reportSuccess(proxy) {
    if (!proxy) return;
    proxy.successes++;
    proxy.failures = 0;
  }

  reportFailure(proxy, reason = 'error') {
    if (!proxy) return;
    proxy.failures++;
    console.warn(`[ProxyManager] Proxy ${proxy.server} reported failure #${proxy.failures}: ${reason}`);

    // If 403, 429, or Volterra block, immediately quarantine
    const isWafBlock = reason.includes('403') || reason.includes('429') || reason.includes('WAF') || reason.includes('blocked');
    if (isWafBlock || proxy.failures >= 3) {
      proxy.quarantinedUntil = Date.now() + this.quarantineTimeMs;
      console.warn(
        `[ProxyManager] QUARANTINED proxy ${proxy.server} for ${Math.round(this.quarantineTimeMs / 60000)} minutes due to: ${reason}`
      );
    }
  }

  toPlaywrightProxy(proxy) {
    if (!proxy) return undefined;
    const res = { server: proxy.server };
    if (proxy.username) res.username = proxy.username;
    if (proxy.password) res.password = proxy.password;
    return res;
  }

  getStats() {
    const now = Date.now();
    return {
      total: this.proxies.length,
      active: this.proxies.filter((p) => p.quarantinedUntil <= now).length,
      quarantined: this.proxies.filter((p) => p.quarantinedUntil > now).length,
      proxies: this.proxies.map((p) => ({
        server: p.server,
        successes: p.successes,
        failures: p.failures,
        isQuarantined: p.quarantinedUntil > now,
        quarantineRemainingSec: Math.max(0, Math.round((p.quarantinedUntil - now) / 1000)),
      })),
    };
  }
}
