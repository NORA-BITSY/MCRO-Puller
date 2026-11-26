import { createHash } from 'crypto';
import { setTimeout as delay } from 'timers/promises';

export interface ProxyEndpoint {
  url: string;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  sessionId: string;
  egressIp?: string | undefined;
  country?: string | undefined;
  lastUsed: number;
  failureCount: number;
  healthy: boolean;
}

export interface ProxyManagerConfig {
  pool: string[];
  healthCheckUrl: string;
  healthCheckIntervalMs: number;
  maxFailuresBeforeRotation: number;
  rotationCooldownMs: number;
  stickySessionTtlMs: number;
}

const DEFAULT_CONFIG: ProxyManagerConfig = {
  pool: [],
  healthCheckUrl: 'https://ip.decodo.com/json',
  healthCheckIntervalMs: 60000,
  maxFailuresBeforeRotation: 2,
  rotationCooldownMs: 5000,
  stickySessionTtlMs: 300000,
};

export class HighAggressionProxyManager {
  private endpoints: Map<string, ProxyEndpoint> = new Map();
  private currentIndex = 0;
  private config: ProxyManagerConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private rotationLock = false;
  private lastRotation = 0;

  constructor(config: Partial<ProxyManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializePool();
    this.startHealthChecks();
  }

  private initializePool(): void {
    for (const entry of this.config.pool) {
      if (!entry.trim()) continue;
      const endpoint = this.parseProxyUrl(entry.trim());
      if (endpoint) {
        this.endpoints.set(endpoint.sessionId, endpoint);
      }
    }
    console.log(`[ProxyManager] Initialized ${this.endpoints.size} residential proxy sessions`);
  }

  private parseProxyUrl(url: string): ProxyEndpoint | null {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;

      const sessionId = createHash('sha256').update(url).digest('hex').slice(0, 16);
      return {
        url,
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        sessionId,
        lastUsed: 0,
        failureCount: 0,
        healthy: true,
      } satisfies ProxyEndpoint;
    } catch {
      return null;
    }
  }

  private async startHealthChecks(): Promise<void> {
    this.healthCheckTimer = setInterval(async () => {
      await this.verifyEgressAll();
    }, this.config.healthCheckIntervalMs);

    await this.verifyEgressAll();
  }

  private async verifyEgressAll(): Promise<void> {
    const promises = Array.from(this.endpoints.values()).map(endpoint => this.verifyEgress(endpoint));
    await Promise.allSettled(promises);
  }

  private async verifyEgress(endpoint: ProxyEndpoint): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(this.config.healthCheckUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'MCRO-Puller/1.0 HealthCheck' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const ip = data?.proxy?.ip;
      const country = data?.country?.code;
      if (!ip) throw new Error('No IP in response');
      if (country !== 'US') throw new Error(`Non-US egress: ${country}`);
      endpoint.egressIp = ip;
      endpoint.country = country;
      endpoint.healthy = true;
      endpoint.failureCount = 0;
    } catch (error) {
      endpoint.failureCount++;
      endpoint.healthy = endpoint.failureCount < this.config.maxFailuresBeforeRotation;
      console.error(`[ProxyManager] Egress verification failed for ${endpoint.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getNextProxy(): Promise<ProxyEndpoint> {
    const healthyEndpoints = Array.from(this.endpoints.values()).filter(e => e.healthy);
    if (healthyEndpoints.length === 0) {
      throw new Error('No healthy proxy endpoints available');
    }

    const now = Date.now();
    const eligible = healthyEndpoints.filter(e => now - e.lastUsed >= this.config.stickySessionTtlMs || e.failureCount > 0);

    let selected: ProxyEndpoint;
    if (eligible.length > 0) {
      selected = eligible.reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
    } else {
      const idx = this.currentIndex % healthyEndpoints.length;
      selected = healthyEndpoints[idx]!;
      this.currentIndex = (this.currentIndex + 1) % healthyEndpoints.length;
    }

    selected.lastUsed = now;
    return selected;
  }

  async reportFailure(proxy: ProxyEndpoint, statusCode: number): Promise<ProxyEndpoint | null> {
    proxy.failureCount++;
    proxy.healthy = proxy.failureCount < this.config.maxFailuresBeforeRotation;

    console.log(`[ProxyManager] Proxy ${proxy.sessionId} reported failure (${statusCode}), failure count: ${proxy.failureCount}`);

    if (!proxy.healthy) {
      return await this.rotateProxy(proxy);
    }
    return proxy;
  }

  async reportSuccess(proxy: ProxyEndpoint): Promise<void> {
    proxy.failureCount = Math.max(0, proxy.failureCount - 1);
    proxy.healthy = true;
  }

  private async rotateProxy(failedProxy: ProxyEndpoint): Promise<ProxyEndpoint | null> {
    const now = Date.now();
    if (this.rotationLock || now - this.lastRotation < this.config.rotationCooldownMs) {
      return await this.getNextProxy();
    }

    this.rotationLock = true;
    this.lastRotation = now;

    try {
      console.log(`[ProxyManager] Rotating away from failed proxy ${failedProxy.sessionId}`);
      const newProxy = await this.getNextProxy();
      console.log(`[ProxyManager] Rotated to proxy ${newProxy.sessionId} (egress: ${newProxy.egressIp})`);
      return newProxy;
    } finally {
      this.rotationLock = false;
    }
  }

  async cycleIdentity(proxy: ProxyEndpoint): Promise<ProxyEndpoint> {
    console.log(`[ProxyManager] Identity expiration event — cycling proxy ${proxy.sessionId}`);
    const rotated = await this.rotateProxy(proxy);
    if (!rotated) throw new Error('No proxy available for identity rotation');
    return rotated;
  }

  getPoolStatus(): { total: number; healthy: number; endpoints: Array<{ sessionId: string; egressIp: string | undefined; healthy: boolean; failures: number }> } {
    return {
      total: this.endpoints.size,
      healthy: Array.from(this.endpoints.values()).filter(e => e.healthy).length,
      endpoints: Array.from(this.endpoints.values()).map(e => ({
        sessionId: e.sessionId,
        egressIp: e.egressIp,
        healthy: e.healthy,
        failures: e.failureCount,
      })),
    };
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }
}

export function createProxyManagerFromEnv(config?: Partial<ProxyManagerConfig>): HighAggressionProxyManager {
  const pool = (process.env.COURT_PROXIES || process.env.COURT_PROXY || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  if (pool.length === 0) {
    throw new Error('No proxy pool configured. Set COURT_PROXIES or COURT_PROXY environment variable.');
  }

  return new HighAggressionProxyManager({ ...config, pool });
}