/**
 * Redis Adapter for Distributed Rate Limiting - TypeScript
 * 
 * Provides Redis-based storage for rate limiting across multiple instances
 */

import { RateLimitStorage } from './rate-limiter';
import { createClient, RedisClientType } from 'redis';

/**
 * Redis configuration options
 */
export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

/**
 * Redis storage implementation for rate limiting
 */
export class RedisStorage implements RateLimitStorage {
  private client: RedisClientType<any>;
  private keyPrefix: string;
  //@ts-ignore
  private connected: boolean = false;

  constructor(client: RedisClientType<any>, keyPrefix: string = 'rate_limit') {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  /**
   * Create Redis storage from configuration
   */
  static async create(config: RedisConfig = {}): Promise<RedisStorage> {
    const client = createClient({
      url: config.url,
      socket: {
        host: config.host || 'localhost',
        port: config.port || 6379
      },
      password: config.password,
      database: config.db || 0
    });

    await client.connect();
    return new RedisStorage(client, config.keyPrefix);
  }

  private makeKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  async get(key: string): Promise<any> {
    const value = await this.client.get(this.makeKey(key));
    if (value === null) return null;
    
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const redisKey = this.makeKey(key);
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttl) {
      await this.client.setEx(redisKey, ttl, stringValue);
    } else {
      await this.client.set(redisKey, stringValue);
    }
  }

  async increment(key: string, amount: number = 1): Promise<number> {
    return await this.client.incrBy(this.makeKey(key), amount);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.makeKey(key));
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    this.connected = false;
  }
}

/**
 * Redis-backed Token Bucket implementation
 */
export class RedisTokenBucket {
  private storage: RedisStorage;
  private capacity: number;
  private refillRate: number;
  private identifier: string;

  // Lua script for atomic token bucket operations
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local tokens_requested = tonumber(ARGV[3])
    local now = tonumber(ARGV[4])
    
    -- Get current state
    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or capacity
    local last_refill = tonumber(bucket[2]) or now
    
    -- Refill tokens
    local elapsed = math.max(0, now - last_refill)
    local tokens_to_add = elapsed * refill_rate
    tokens = math.min(capacity, tokens + tokens_to_add)
    
    -- Try to consume
    local allowed = 0
    if tokens >= tokens_requested then
      tokens = tokens - tokens_requested
      allowed = 1
    end
    
    -- Update state
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 3600)
    
    -- Calculate retry_after
    local retry_after = 0
    if allowed == 0 then
      local tokens_needed = tokens_requested - tokens
      retry_after = tokens_needed / refill_rate
    end
    
    return {allowed, math.floor(tokens), retry_after}
  `;

  constructor(
    storage: RedisStorage,
    identifier: string,
    capacity: number,
    refillRate: number
  ) {
    this.storage = storage;
    this.identifier = identifier;
    this.capacity = capacity;
    this.refillRate = refillRate;
  }

  async consume(tokens: number = 1): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfter?: number;
  }> {
    const key = `token_bucket:${this.identifier}`;
    const now = Date.now() / 1000;

    // Execute Lua script
    const client = (this.storage as any).client;
    const result = await client.eval(RedisTokenBucket.SCRIPT, {
      keys: [key],
      arguments: [
        this.capacity.toString(),
        this.refillRate.toString(),
        tokens.toString(),
        now.toString()
      ]
    }) as number[];

    const [allowed, remaining, retryAfter] = result;

    return {
      allowed: Boolean(allowed),
      remaining: Number(remaining),
      retryAfter: retryAfter > 0 ? Number(retryAfter) : undefined
    };
  }
}

/**
 * Redis-backed Sliding Window Counter implementation
 */
export class RedisSlidingWindowCounter {
  private storage: RedisStorage;
  private windowSize: number; // in seconds
  private limit: number;
  private identifier: string;

  // Lua script for atomic sliding window operations
  private static readonly SCRIPT = `
    local current_key = KEYS[1]
    local previous_key = KEYS[2]
    local window_size = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local tokens = tonumber(ARGV[3])
    local now = tonumber(ARGV[4])
    local window_start = tonumber(ARGV[5])
    
    -- Get counts
    local current = tonumber(redis.call('GET', current_key) or 0)
    local previous = tonumber(redis.call('GET', previous_key) or 0)
    
    -- Calculate estimated count
    local elapsed = now - window_start
    local overlap_pct = (window_size - elapsed) / window_size
    local estimated_count = math.floor(previous * overlap_pct) + current
    
    local allowed = 0
    local remaining = limit
    
    if estimated_count + tokens <= limit then
      redis.call('INCRBY', current_key, tokens)
      redis.call('EXPIRE', current_key, window_size * 2)
      allowed = 1
      remaining = limit - estimated_count - tokens
    else
      remaining = 0
    end
    
    return {allowed, remaining, estimated_count}
  `;

  constructor(
    storage: RedisStorage,
    identifier: string,
    windowSize: number,
    limit: number
  ) {
    this.storage = storage;
    this.identifier = identifier;
    this.windowSize = windowSize;
    this.limit = limit;
  }

  async consume(tokens: number = 1): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }> {
    const now = Date.now() / 1000;
    const windowStart = Math.floor(now / this.windowSize) * this.windowSize;
    const prevWindowStart = windowStart - this.windowSize;

    const currentKey = `sliding_window:${this.identifier}:${windowStart}`;
    const previousKey = `sliding_window:${this.identifier}:${prevWindowStart}`;

    // Execute Lua script
    const client = (this.storage as any).client;
    const result = await client.eval(RedisSlidingWindowCounter.SCRIPT, {
      keys: [currentKey, previousKey],
      arguments: [
        this.windowSize.toString(),
        this.limit.toString(),
        tokens.toString(),
        now.toString(),
        windowStart.toString()
      ]
    }) as number[];

    const [allowed, remaining] = result;

    return {
      allowed: Boolean(allowed),
      remaining: Math.max(0, Number(remaining)),
      resetAt: (windowStart + this.windowSize) * 1000
    };
  }
}

/**
 * Redis-backed Fixed Window Counter
 */
export class RedisFixedWindowCounter {
  private storage: RedisStorage;
  private windowSize: number;
  private limit: number;
  private identifier: string;

  constructor(
    storage: RedisStorage,
    identifier: string,
    windowSize: number,
    limit: number
  ) {
    this.storage = storage;
    this.identifier = identifier;
    this.windowSize = windowSize;
    this.limit = limit;
  }

  async consume(tokens: number = 1): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }> {
    const now = Date.now() / 1000;
    const windowStart = Math.floor(now / this.windowSize) * this.windowSize;
    const key = `fixed_window:${this.identifier}:${windowStart}`;

    const client = (this.storage as any).client;

    // Get current count
    const current = await client.get(key);
    const currentCount = current ? parseInt(current) : 0;

    if (currentCount + tokens <= this.limit) {
      // Increment and set expiry
      const newCount = await client.incrBy(key, tokens);
      await client.expire(key, this.windowSize * 2);

      return {
        allowed: true,
        remaining: this.limit - newCount,
        resetAt: (windowStart + this.windowSize) * 1000
      };
    }

    return {
      allowed: false,
      remaining: 0,
      resetAt: (windowStart + this.windowSize) * 1000
    };
  }
}

/**
 * Factory for creating Redis-backed rate limiters
 */
export class RedisRateLimiterFactory {
  private storage: RedisStorage;

  constructor(storage: RedisStorage) {
    this.storage = storage;
  }

  /**
   * Create from Redis configuration
   */
  static async create(config: RedisConfig = {}): Promise<RedisRateLimiterFactory> {
    const storage = await RedisStorage.create(config);
    return new RedisRateLimiterFactory(storage);
  }

  /**
   * Create a token bucket rate limiter
   */
  tokenBucket(
    identifier: string,
    capacity: number,
    refillRate: number
  ): RedisTokenBucket {
    return new RedisTokenBucket(this.storage, identifier, capacity, refillRate);
  }

  /**
   * Create a sliding window counter rate limiter
   */
  slidingWindow(
    identifier: string,
    windowSize: number,
    limit: number
  ): RedisSlidingWindowCounter {
    return new RedisSlidingWindowCounter(this.storage, identifier, windowSize, limit);
  }

  /**
   * Create a fixed window counter rate limiter
   */
  fixedWindow(
    identifier: string,
    windowSize: number,
    limit: number
  ): RedisFixedWindowCounter {
    return new RedisFixedWindowCounter(this.storage, identifier, windowSize, limit);
  }

  /**
   * Get the underlying storage
   */
  getStorage(): RedisStorage {
    return this.storage;
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    await this.storage.disconnect();
  }
}

/**
 * Example usage
 */
export async function exampleUsage() {
  // Create Redis-backed rate limiter factory
  const factory = await RedisRateLimiterFactory.create({
    host: 'localhost',
    port: 6379
  });

  // Token bucket example
  const tokenBucket = factory.tokenBucket('user:123', 100, 10);
  
  for (let i = 0; i < 15; i++) {
    const result = await tokenBucket.consume();
    console.log(`Request ${i + 1}: ${result.allowed ? '✓' : '✗'} (remaining: ${result.remaining})`);
  }

  // Sliding window example
  const slidingWindow = factory.slidingWindow('api:endpoint', 60, 100);
  
  for (let i = 0; i < 10; i++) {
    const result = await slidingWindow.consume();
    console.log(`Request ${i + 1}: ${result.allowed ? '✓' : '✗'} (remaining: ${result.remaining})`);
  }

  // Close connection
  await factory.close();
}

// Export all
// export {
//   RedisConfig,
//   RedisStorage,
//   RedisTokenBucket,
//   RedisSlidingWindowCounter,
//   RedisFixedWindowCounter
// };
