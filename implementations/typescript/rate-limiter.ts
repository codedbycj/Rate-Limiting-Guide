/**
 * Rate Limiting Library - TypeScript Implementation
 * 
 * Provides multiple rate limiting algorithms:
 * - Token Bucket
 * - Leaky Bucket
 * - Fixed Window Counter
 * - Sliding Window Log
 * - Sliding Window Counter
 * - Concurrent Requests Limiter
 */

/**
 * Result of a rate limit check
 */
interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Configuration for rate limiters
 */
interface RateLimiterConfig {
  identifier?: string;
  onRateLimit?: (result: RateLimitResult) => void;
}

/**
 * Abstract base class for rate limiters
 */
abstract class RateLimiter {
  protected config: RateLimiterConfig;

  constructor(config: RateLimiterConfig = {}) {
    this.config = config;
  }

  abstract allowRequest(tokens?: number): Promise<RateLimitResult> | RateLimitResult;
  abstract reset(): void;
}

/**
 * Token Bucket Algorithm
 * 
 * Tokens are added at a constant rate. Each request consumes tokens.
 * Allows bursts up to bucket capacity while maintaining average rate.
 * 
 * Best for: APIs that need to allow occasional bursts
 */
export class TokenBucketLimiter extends RateLimiter {
  private capacity: number;
  private refillRate: number; // tokens per second
  private tokens: number;
  private lastRefill: number;

  /**
   * @param capacity - Maximum number of tokens in bucket
   * @param refillRate - Rate at which tokens are added (per second)
   * @param config - Additional configuration
   */
  constructor(capacity: number, refillRate: number, config?: RateLimiterConfig) {
    super(config);
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      
      return {
        allowed: true,
        limit: this.capacity,
        remaining: Math.floor(this.tokens),
        resetAt: Date.now() + ((this.capacity - this.tokens) / this.refillRate) * 1000
      };
    }

    const tokensNeeded = tokens - this.tokens;
    const retryAfter = (tokensNeeded / this.refillRate) * 1000;

    const result: RateLimitResult = {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      resetAt: Date.now() + retryAfter,
      retryAfter: retryAfter / 1000
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Leaky Bucket Algorithm
 * 
 * Requests leak out of the bucket at a constant rate.
 * Enforces strict output rate, smoothing bursts.
 * 
 * Best for: Protecting downstream services with strict rate requirements
 */
export class LeakyBucketLimiter extends RateLimiter {
  private capacity: number;
  private leakRate: number; // requests per second
  private queue: number[];
  private lastLeak: number;

  /**
   * @param capacity - Maximum queue size
   * @param leakRate - Rate at which requests are processed (per second)
   * @param config - Additional configuration
   */
  constructor(capacity: number, leakRate: number, config?: RateLimiterConfig) {
    super(config);
    this.capacity = capacity;
    this.leakRate = leakRate;
    this.queue = [];
    this.lastLeak = Date.now();
  }

  private leak(): void {
    const now = Date.now();
    const elapsed = (now - this.lastLeak) / 1000;
    const requestsToLeak = Math.floor(elapsed * this.leakRate);

    for (let i = 0; i < Math.min(requestsToLeak, this.queue.length); i++) {
      this.queue.shift();
    }

    this.lastLeak = now;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    this.leak();

    if (this.queue.length + tokens <= this.capacity) {
      for (let i = 0; i < tokens; i++) {
        this.queue.push(Date.now());
      }

      return {
        allowed: true,
        limit: this.capacity,
        remaining: this.capacity - this.queue.length,
        resetAt: Date.now() + (this.queue.length / this.leakRate) * 1000
      };
    }

    const retryAfter = ((this.queue.length - this.capacity + tokens) / this.leakRate) * 1000;

    const result: RateLimitResult = {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      resetAt: Date.now() + retryAfter,
      retryAfter: retryAfter / 1000
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    this.queue = [];
    this.lastLeak = Date.now();
  }

  getQueueLength(): number {
    this.leak();
    return this.queue.length;
  }
}

/**
 * Fixed Window Counter Algorithm
 * 
 * Counts requests in fixed time windows.
 * Simple and memory-efficient but has boundary spike issues.
 * 
 * Best for: Simple use cases where approximate limiting is acceptable
 */
export class FixedWindowLimiter extends RateLimiter {
  private windowSize: number; // in milliseconds
  private limit: number;
  private windowStart: number;
  private count: number;

  /**
   * @param windowSize - Window size in seconds
   * @param limit - Maximum requests per window
   * @param config - Additional configuration
   */
  constructor(windowSize: number, limit: number, config?: RateLimiterConfig) {
    super(config);
    this.windowSize = windowSize * 1000;
    this.limit = limit;
    this.windowStart = this.getCurrentWindow();
    this.count = 0;
  }

  private getCurrentWindow(): number {
    return Math.floor(Date.now() / this.windowSize) * this.windowSize;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    const currentWindow = this.getCurrentWindow();

    // Reset if in new window
    if (currentWindow !== this.windowStart) {
      this.windowStart = currentWindow;
      this.count = 0;
    }

    if (this.count + tokens <= this.limit) {
      this.count += tokens;

      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - this.count,
        resetAt: this.windowStart + this.windowSize
      };
    }

    const result: RateLimitResult = {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: this.windowStart + this.windowSize,
      retryAfter: (this.windowStart + this.windowSize - Date.now()) / 1000
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    this.windowStart = this.getCurrentWindow();
    this.count = 0;
  }
}

/**
 * Sliding Window Log Algorithm
 * 
 * Maintains a log of all request timestamps.
 * Most accurate but memory intensive for high traffic.
 * 
 * Best for: When you need precise rate limiting and have moderate traffic
 */
export class SlidingWindowLogLimiter extends RateLimiter {
  private windowSize: number; // in milliseconds
  private limit: number;
  private requests: number[];

  /**
   * @param windowSize - Window size in seconds
   * @param limit - Maximum requests per window
   * @param config - Additional configuration
   */
  constructor(windowSize: number, limit: number, config?: RateLimiterConfig) {
    super(config);
    this.windowSize = windowSize * 1000;
    this.limit = limit;
    this.requests = [];
  }

  private removeOldRequests(): void {
    const now = Date.now();
    const cutoff = now - this.windowSize;
    
    // Remove timestamps older than the window
    while (this.requests.length > 0 && this.requests[0] <= cutoff) {
      this.requests.shift();
    }
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    this.removeOldRequests();
    const now = Date.now();

    if (this.requests.length + tokens <= this.limit) {
      for (let i = 0; i < tokens; i++) {
        this.requests.push(now);
      }

      const oldestRequest = this.requests[0] || now;

      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - this.requests.length,
        resetAt: oldestRequest + this.windowSize
      };
    }

    const oldestRequest = this.requests[0];
    const retryAfter = oldestRequest ? (oldestRequest + this.windowSize - now) / 1000 : 0;

    const result: RateLimitResult = {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: oldestRequest ? oldestRequest + this.windowSize : now,
      retryAfter: Math.max(0, retryAfter)
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    this.requests = [];
  }

  getRequestCount(): number {
    this.removeOldRequests();
    return this.requests.length;
  }
}

/**
 * Sliding Window Counter Algorithm
 * 
 * Hybrid approach using two fixed windows with weighted calculation.
 * Best balance of accuracy and efficiency for production systems.
 * 
 * Best for: Production APIs with high traffic
 */
export class SlidingWindowCounterLimiter extends RateLimiter {
  private windowSize: number; // in milliseconds
  private limit: number;
  private currentWindow: { start: number; count: number };
  private previousWindow: { start: number; count: number };

  /**
   * @param windowSize - Window size in seconds
   * @param limit - Maximum requests per window
   * @param config - Additional configuration
   */
  constructor(windowSize: number, limit: number, config?: RateLimiterConfig) {
    super(config);
    this.windowSize = windowSize * 1000;
    this.limit = limit;
    this.currentWindow = { start: 0, count: 0 };
    this.previousWindow = { start: 0, count: 0 };
  }

  private getWindowStart(timestamp: number): number {
    return Math.floor(timestamp / this.windowSize) * this.windowSize;
  }

  private estimateCount(now: number): number {
    const elapsed = now - this.currentWindow.start;
    const overlapPercent = Math.max(0, (this.windowSize - elapsed) / this.windowSize);
    
    return Math.floor(this.previousWindow.count * overlapPercent) + this.currentWindow.count;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    const now = Date.now();
    const windowStart = this.getWindowStart(now);

    // Move to new window if needed
    if (windowStart !== this.currentWindow.start) {
      this.previousWindow = { ...this.currentWindow };
      this.currentWindow = { start: windowStart, count: 0 };
    }

    const estimatedCount = this.estimateCount(now);

    if (estimatedCount + tokens <= this.limit) {
      this.currentWindow.count += tokens;

      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, this.limit - estimatedCount - tokens),
        resetAt: this.currentWindow.start + this.windowSize
      };
    }

    const result: RateLimitResult = {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: this.currentWindow.start + this.windowSize,
      retryAfter: (this.currentWindow.start + this.windowSize - now) / 1000
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    const now = Date.now();
    const windowStart = this.getWindowStart(now);
    this.currentWindow = { start: windowStart, count: 0 };
    this.previousWindow = { start: 0, count: 0 };
  }

  getCurrentCount(): number {
    return this.estimateCount(Date.now());
  }
}

/**
 * Concurrent Requests Limiter
 * 
 * Limits the number of simultaneous active requests.
 * Use with request completion tracking.
 * 
 * Best for: Limiting concurrent connections or active processing
 */
export class ConcurrentRequestsLimiter extends RateLimiter {
  private maxConcurrent: number;
  private activeRequests: number;

  /**
   * @param maxConcurrent - Maximum concurrent requests
   * @param config - Additional configuration
   */
  constructor(maxConcurrent: number, config?: RateLimiterConfig) {
    super(config);
    this.maxConcurrent = maxConcurrent;
    this.activeRequests = 0;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    if (this.activeRequests + tokens <= this.maxConcurrent) {
      this.activeRequests += tokens;

      return {
        allowed: true,
        limit: this.maxConcurrent,
        remaining: this.maxConcurrent - this.activeRequests,
        resetAt: 0 // Not applicable for concurrent limiter
      };
    }

    const result: RateLimitResult = {
      allowed: false,
      limit: this.maxConcurrent,
      remaining: 0,
      resetAt: 0
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  /**
   * Release tokens when request completes
   */
  release(tokens: number = 1): void {
    this.activeRequests = Math.max(0, this.activeRequests - tokens);
  }

  reset(): void {
    this.activeRequests = 0;
  }

  getActiveCount(): number {
    return this.activeRequests;
  }
}

/**
 * Multi-tier Rate Limiter
 * 
 * Combines multiple rate limiters (e.g., per-second AND per-hour limits)
 */
export class MultiTierLimiter extends RateLimiter {
  private limiters: RateLimiter[];

  /**
   * @param limiters - Array of rate limiters to check
   * @param config - Additional configuration
   */
  constructor(limiters: RateLimiter[], config?: RateLimiterConfig) {
    super(config);
    this.limiters = limiters;
  }

  async allowRequest(tokens: number = 1): Promise<RateLimitResult> {
    const results: RateLimitResult[] = [];

    for (const limiter of this.limiters) {
      const result = await limiter.allowRequest(tokens);
      results.push(result);

      if (!result.allowed) {
        return result;
      }
    }

    // Return most restrictive result
    return results.reduce((most, current) => 
      current.remaining < most.remaining ? current : most
    );
  }

  reset(): void {
    this.limiters.forEach(limiter => limiter.reset());
  }
}

/**
 * Storage interface for distributed rate limiting
 */
interface RateLimitStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  increment(key: string, amount?: number): Promise<number>;
  delete(key: string): Promise<void>;
}

/**
 * In-memory storage implementation
 */
export class MemoryStorage implements RateLimitStorage {
  private store: Map<string, { value: any; expires?: number }> = new Map();

  async get(key: string): Promise<any> {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && item.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const expires = ttl ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expires });
  }

  async increment(key: string, amount: number = 1): Promise<number> {
    const current = await this.get(key) || 0;
    const newValue = current + amount;
    await this.set(key, newValue);
    return newValue;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Distributed Sliding Window Counter (requires external storage like Redis)
 */
export class DistributedSlidingWindowCounter extends RateLimiter {
  private windowSize: number;
  private limit: number;
  private storage: RateLimitStorage;
  private keyPrefix: string;

  constructor(
    windowSize: number,
    limit: number,
    storage: RateLimitStorage,
    config?: RateLimiterConfig & { keyPrefix?: string }
  ) {
    super(config);
    this.windowSize = windowSize * 1000;
    this.limit = limit;
    this.storage = storage;
    this.keyPrefix = config?.keyPrefix || 'rate_limit';
  }

  private getWindowStart(timestamp: number): number {
    return Math.floor(timestamp / this.windowSize) * this.windowSize;
  }

  async allowRequest(tokens: number = 1): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = this.getWindowStart(now);
    const prevWindowStart = windowStart - this.windowSize;

    const identifier = this.config.identifier || 'default';
    const currentKey = `${this.keyPrefix}:${identifier}:${windowStart}`;
    const previousKey = `${this.keyPrefix}:${identifier}:${prevWindowStart}`;

    // Get counts from both windows
    const [currentCount, previousCount] = await Promise.all([
      this.storage.get(currentKey).then(v => Number(v) || 0),
      this.storage.get(previousKey).then(v => Number(v) || 0)
    ]);

    // Calculate estimated count
    const elapsed = now - windowStart;
    const overlapPercent = Math.max(0, (this.windowSize - elapsed) / this.windowSize);
    const estimatedCount = Math.floor(previousCount * overlapPercent) + currentCount;

    if (estimatedCount + tokens <= this.limit) {
      // Increment current window
      await this.storage.increment(currentKey, tokens);
      await this.storage.set(currentKey, currentCount + tokens, this.windowSize / 1000 * 2);

      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, this.limit - estimatedCount - tokens),
        resetAt: windowStart + this.windowSize
      };
    }

    const result: RateLimitResult = {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: windowStart + this.windowSize,
      retryAfter: (windowStart + this.windowSize - now) / 1000
    };

    if (this.config.onRateLimit) {
      this.config.onRateLimit(result);
    }

    return result;
  }

  reset(): void {
    // Reset would need to be implemented based on storage
    // For distributed systems, this might clear all keys for the identifier
  }
}

// Export all classes
export {
  RateLimiter,
  RateLimiterConfig,
  RateLimitResult,
  RateLimitStorage
};
