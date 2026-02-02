# Distributed Rate Limiting

## Overview

When running multiple application instances, you need distributed rate limiting to share state across all instances. This ensures accurate rate limiting regardless of which server handles the request.

## The Problem

### Single Instance (Works Fine)
```
User Request → Server → Rate Limiter → Allow/Deny
```

### Multiple Instances (Broken Without Distribution)
```
User Request → Load Balancer → Server 1 → Rate Limiter (count: 50)
User Request → Load Balancer → Server 2 → Rate Limiter (count: 50)
User Request → Load Balancer → Server 3 → Rate Limiter (count: 50)

Problem: User made 150 requests but each server only sees 50!
```

### Solution: Shared State
```
User Request → Load Balancer → Server 1 ↘
User Request → Load Balancer → Server 2 → Redis (shared count: 150)
User Request → Load Balancer → Server 3 ↗
```

## Solutions

### 1. Redis-Based Rate Limiting ⭐ (Recommended)

Redis is the most popular solution for distributed rate limiting.

#### Advantages
- ✅ Atomic operations (Lua scripts)
- ✅ Built-in expiration (TTL)
- ✅ High performance (in-memory)
- ✅ Easy to implement
- ✅ Widely supported

#### Basic Implementation

```typescript
import { createClient } from 'redis';

const redis = createClient({ url: 'redis://localhost:6379' });
await redis.connect();

async function checkRateLimit(userId: string, limit: number, windowSize: number): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (windowSize * 1000));
  const key = `rate:${userId}:${window}`;

  const count = await redis.incr(key);
  
  if (count === 1) {
    await redis.expire(key, windowSize * 2);
  }

  return count <= limit;
}
```

#### Advanced: Atomic Lua Script

```typescript
const luaScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local window = math.floor(now / window_size)
local current_key = key .. ':' .. window

local count = redis.call('INCR', current_key)

if count == 1 then
    redis.call('EXPIRE', current_key, window_size * 2)
end

local allowed = count <= limit
return {allowed and 1 or 0, count, limit - count}
`;

async function rateLimitWithLua(userId: string, limit: number, windowSize: number) {
  const result = await redis.eval(luaScript, {
    keys: [`rate:${userId}`],
    arguments: [limit.toString(), windowSize.toString(), Date.now().toString()]
  });
  
  return {
    allowed: result[0] === 1,
    current: result[1],
    remaining: result[2]
  };
}
```

#### Sliding Window Counter with Redis

```typescript
const slidingWindowScript = `
local current_key = KEYS[1]
local previous_key = KEYS[2]
local limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local window_start = tonumber(ARGV[4])

local current = tonumber(redis.call('GET', current_key) or 0)
local previous = tonumber(redis.call('GET', previous_key) or 0)

local elapsed = now - window_start
local overlap_pct = (window_size - elapsed) / window_size
local estimated_count = math.floor(previous * overlap_pct) + current

if estimated_count < limit then
    redis.call('INCR', current_key)
    redis.call('EXPIRE', current_key, window_size * 2)
    return {1, limit - estimated_count - 1}
else
    return {0, 0}
end
`;

class RedisSlidingWindowCounter {
  private redis: RedisClient;
  private script: string;

  constructor(redis: RedisClient) {
    this.redis = redis;
    this.script = slidingWindowScript;
  }

  async checkLimit(userId: string, limit: number, windowSize: number): Promise<RateLimitResult> {
    const now = Date.now() / 1000;
    const windowStart = Math.floor(now / windowSize) * windowSize;
    const prevWindowStart = windowStart - windowSize;

    const currentKey = `rate:${userId}:${windowStart}`;
    const previousKey = `rate:${userId}:${prevWindowStart}`;

    const result = await this.redis.eval(this.script, {
      keys: [currentKey, previousKey],
      arguments: [limit, windowSize, now, windowStart]
    });

    return {
      allowed: result[0] === 1,
      remaining: result[1]
    };
  }
}
```

### 2. Memcached

Similar to Redis but simpler, no Lua scripts.

```typescript
import Memcached from 'memcached';

const memcached = new Memcached('localhost:11211');

async function rateLimitMemcached(userId: string, limit: number, windowSize: number): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (windowSize * 1000));
  const key = `rate:${userId}:${window}`;

  return new Promise((resolve) => {
    memcached.incr(key, 1, (err, result) => {
      if (err || result === false) {
        // Key doesn't exist, create it
        memcached.set(key, 1, windowSize * 2, () => {
          resolve(true);
        });
      } else {
        resolve(result <= limit);
      }
    });
  });
}
```

### 3. Database-Based (PostgreSQL/MySQL)

For when Redis isn't available.

```sql
CREATE TABLE rate_limits (
    user_id VARCHAR(255),
    window_start BIGINT,
    count INT,
    PRIMARY KEY (user_id, window_start)
);

CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
```

```typescript
async function rateLimitDB(userId: string, limit: number, windowSize: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSize * 1000)) * (windowSize * 1000);

  const result = await db.query(`
    INSERT INTO rate_limits (user_id, window_start, count)
    VALUES ($1, $2, 1)
    ON CONFLICT (user_id, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `, [userId, windowStart]);

  // Clean up old windows
  await db.query(`
    DELETE FROM rate_limits 
    WHERE window_start < $1
  `, [now - (windowSize * 2 * 1000)]);

  return result.rows[0].count <= limit;
}
```

⚠️ **Warning**: Database-based rate limiting can become a bottleneck under high load.

### 4. API Gateway Solutions

#### Kong
```yaml
plugins:
  - name: rate-limiting
    config:
      minute: 100
      policy: redis
      redis_host: localhost
      redis_port: 6379
```

#### NGINX
```nginx
limit_req_zone $binary_remote_addr zone=mylimit:10m rate=10r/s;

server {
    location /api/ {
        limit_req zone=mylimit burst=20;
    }
}
```

#### AWS API Gateway
```yaml
Resources:
  ApiGatewayUsagePlan:
    Type: AWS::ApiGateway::UsagePlan
    Properties:
      Throttle:
        BurstLimit: 200
        RateLimit: 100
```

### 5. DynamoDB (AWS)

```typescript
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

async function rateLimitDynamoDB(userId: string, limit: number, windowSize: number): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (windowSize * 1000));
  
  const client = new DynamoDBClient({});
  
  try {
    const result = await client.send(new UpdateItemCommand({
      TableName: 'RateLimits',
      Key: {
        userId: { S: userId },
        window: { N: window.toString() }
      },
      UpdateExpression: 'ADD #count :inc',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':inc': { N: '1' } },
      ReturnValues: 'ALL_NEW'
    }));

    const count = parseInt(result.Attributes?.count?.N || '0');
    return count <= limit;
  } catch (error) {
    console.error('DynamoDB error:', error);
    return true; // Fail open
  }
}
```

## Architecture Patterns

### 1. Centralized Rate Limiting

```
┌──────────┐     ┌──────────┐     ┌───────────┐
│  Client  │────▶│   LB     │────▶│  Server 1 │
└──────────┘     └──────────┘     └─────┬─────┘
                       │                 │
                       │           ┌─────▼─────┐
                       │           │  Server 2 │
                       │           └─────┬─────┘
                       │                 │
                       │           ┌─────▼─────┐
                       └──────────▶│   Redis   │◀──── All servers share
                                   └───────────┘      rate limit state
```

### 2. Edge Rate Limiting

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│  Client  │────▶│ CDN/Edge     │────▶│ Backend  │
└──────────┘     │ (Rate Limit) │     └──────────┘
                 └──────────────┘
                 Rate limit at edge,
                 before hitting backend
```

### 3. Tiered Rate Limiting

```
                ┌─────────────┐
                │ Global Limit│ (All users)
                └──────┬──────┘
                       │
            ┌──────────┴──────────┐
            │                     │
     ┌──────▼──────┐      ┌──────▼──────┐
     │  Per-IP     │      │  Per-User   │
     │  Limit      │      │  Limit      │
     └─────────────┘      └─────────────┘
```

## Best Practices

### 1. Handle Redis Failures

```typescript
class ResilientRateLimiter {
  private redis: RedisClient;
  private fallbackLimiter: TokenBucketLimiter;

  async allowRequest(userId: string): Promise<boolean> {
    try {
      // Try Redis first
      return await this.checkRedis(userId);
    } catch (error) {
      console.error('Redis error, using fallback:', error);
      // Fail over to in-memory limiter
      return this.fallbackLimiter.allowRequest().allowed;
    }
  }
}
```

### 2. Use Connection Pooling

```typescript
import { createClient } from 'redis';

// Create pool of Redis connections
const redisPool = Array.from({ length: 10 }, () => 
  createClient({ url: 'redis://localhost:6379' })
);

let currentIndex = 0;

function getRedisClient(): RedisClient {
  const client = redisPool[currentIndex];
  currentIndex = (currentIndex + 1) % redisPool.length;
  return client;
}
```

### 3. Implement Circuit Breaker

```typescript
class CircuitBreaker {
  private failures = 0;
  private isOpen = false;
  private lastFailureTime = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      if (Date.now() - this.lastFailureTime > 60000) {
        this.isOpen = false;
        this.failures = 0;
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= 5) {
        this.isOpen = true;
      }
      throw error;
    }
  }
}
```

### 4. Monitor Performance

```typescript
class MonitoredRateLimiter {
  private metrics = {
    redisLatency: [] as number[],
    hitRate: 0,
    totalRequests: 0,
    allowedRequests: 0
  };

  async checkLimit(userId: string): Promise<boolean> {
    const start = Date.now();
    
    try {
      const allowed = await this.redis.checkLimit(userId);
      
      this.metrics.redisLatency.push(Date.now() - start);
      this.metrics.totalRequests++;
      if (allowed) this.metrics.allowedRequests++;
      
      return allowed;
    } catch (error) {
      // Track errors
      console.error('Rate limiter error:', error);
      throw error;
    }
  }

  getMetrics() {
    const avgLatency = this.metrics.redisLatency.reduce((a, b) => a + b, 0) / 
                      this.metrics.redisLatency.length;
    
    return {
      averageLatency: avgLatency,
      hitRate: this.metrics.allowedRequests / this.metrics.totalRequests,
      totalRequests: this.metrics.totalRequests
    };
  }
}
```

## Performance Optimization

### 1. Pipeline Redis Commands

```typescript
async function batchRateLimit(userIds: string[]): Promise<boolean[]> {
  const pipeline = redis.pipeline();
  
  userIds.forEach(userId => {
    const key = `rate:${userId}:${Date.now()}`;
    pipeline.incr(key);
  });

  const results = await pipeline.exec();
  return results.map(([err, count]) => count <= limit);
}
```

### 2. Use Redis Cluster

```typescript
import { Cluster } from 'ioredis';

const cluster = new Cluster([
  { host: 'redis-1', port: 6379 },
  { host: 'redis-2', port: 6379 },
  { host: 'redis-3', port: 6379 }
]);

// Automatically distributes keys across nodes
```

### 3. Local Caching

```typescript
class CachedRateLimiter {
  private localCache = new Map<string, { count: number; expires: number }>();

  async checkLimit(userId: string, limit: number): Promise<boolean> {
    // Check local cache first (fast)
    const cached = this.localCache.get(userId);
    if (cached && cached.expires > Date.now()) {
      if (cached.count < limit) {
        cached.count++;
        return true;
      }
      return false;
    }

    // Fetch from Redis (slower)
    const result = await this.redis.checkLimit(userId);
    
    // Cache locally for 1 second
    this.localCache.set(userId, {
      count: 1,
      expires: Date.now() + 1000
    });

    return result;
  }
}
```

## Testing Distributed Rate Limiters

```typescript
describe('Distributed Rate Limiting', () => {
  test('should limit across multiple instances', async () => {
    const redis = createClient();
    
    // Simulate 3 server instances
    const limiter1 = new RedisSlidingWindowCounter(redis);
    const limiter2 = new RedisSlidingWindowCounter(redis);
    const limiter3 = new RedisSlidingWindowCounter(redis);

    // Each makes 40 requests (120 total, limit is 100)
    const results1 = await Promise.all(
      Array(40).fill(null).map(() => limiter1.checkLimit('user1', 100, 60))
    );
    
    const results2 = await Promise.all(
      Array(40).fill(null).map(() => limiter2.checkLimit('user1', 100, 60))
    );
    
    const results3 = await Promise.all(
      Array(40).fill(null).map(() => limiter3.checkLimit('user1', 100, 60))
    );

    const totalAllowed = [results1, results2, results3]
      .flat()
      .filter(r => r.allowed).length;

    // Should allow exactly 100
    expect(totalAllowed).toBe(100);
  });
});
```

## Conclusion

For most distributed systems, **Redis with Lua scripts** provides the best balance of:
- Performance
- Accuracy
- Ease of implementation
- Reliability

Consider API Gateway solutions for enterprise deployments or when you need additional features like authentication and routing.
