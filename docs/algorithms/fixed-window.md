# Fixed Window Counter Algorithm

## Overview

The Fixed Window Counter is the simplest rate limiting algorithm. It divides time into fixed windows and counts requests in each window. When a window expires, the counter resets.

## How It Works

1. Time is divided into fixed windows (e.g., 60-second windows)
2. Each window has a counter starting at 0
3. Each request increments the counter
4. If counter >= limit, reject the request
5. When the window ends, counter resets to 0

### Visual Representation

```
Time:     0s────────60s────────120s───────180s
Window 1: [20 requests]
Window 2:              [35 requests]
Window 3:                           [42 requests]

At 30s: counter = 20, allowed
At 90s: counter = 35, allowed
At 150s: counter = 42, allowed
```

### The Boundary Problem

```
Window 1 (0-60s):    [||||||||||||||||||||] 100 requests at t=59s
Window 2 (60-120s):  [||||||||||||||||||||] 100 requests at t=61s

Result: 200 requests in 2 seconds!
Problem: Spike at window boundary
```

## Algorithm Details

### Parameters

- **Window Size (W)**: Duration of each window in seconds
- **Limit (L)**: Maximum requests allowed per window
- **Current Window Start**: Start time of current window
- **Counter**: Number of requests in current window

### Pseudocode

```
class FixedWindowCounter:
    window_size: int
    limit: int
    window_start: timestamp
    counter: int

    function allow_request():
        current_window = floor(current_time() / window_size) * window_size
        
        if current_window != window_start:
            # New window - reset counter
            window_start = current_window
            counter = 0
        
        if counter < limit:
            counter += 1
            return True
        else:
            return False
```

## Characteristics

### Advantages

1. **Very Simple**: Easiest to understand and implement
2. **Memory Efficient**: Only stores 2 numbers (counter + timestamp)
3. **Fast**: O(1) time complexity
4. **Low CPU**: Minimal processing required
5. **Easy to Distribute**: Simple to implement with Redis

### Disadvantages

1. **Boundary Problem**: Can allow 2× limit at window edges
2. **Unfair**: Early requests in window have advantage
3. **Burst Spikes**: Doesn't prevent sudden bursts
4. **Inaccurate**: Can deviate significantly from desired rate

## Implementation

### TypeScript Implementation

```typescript
export class FixedWindowLimiter {
  private windowSize: number; // in milliseconds
  private limit: number;
  private windowStart: number;
  private count: number;

  constructor(windowSize: number, limit: number) {
    this.windowSize = windowSize * 1000; // convert to ms
    this.limit = limit;
    this.windowStart = this.getCurrentWindow();
    this.count = 0;
  }

  private getCurrentWindow(): number {
    return Math.floor(Date.now() / this.windowSize) * this.windowSize;
  }

  allowRequest(tokens: number = 1): RateLimitResult {
    const currentWindow = this.getCurrentWindow();

    // Reset if new window
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

    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: this.windowStart + this.windowSize,
      retryAfter: (this.windowStart + this.windowSize - Date.now()) / 1000
    };
  }

  reset(): void {
    this.windowStart = this.getCurrentWindow();
    this.count = 0;
  }
}
```

### Python Implementation

```python
import time
import math

class FixedWindowLimiter:
    def __init__(self, window_size: int, limit: int):
        self.window_size = window_size
        self.limit = limit
        self.window_start = self._get_current_window()
        self.count = 0
    
    def _get_current_window(self) -> int:
        now = time.time()
        return int(now // self.window_size) * self.window_size
    
    def allow_request(self, tokens: int = 1) -> dict:
        current_window = self._get_current_window()
        
        # Reset if new window
        if current_window != self.window_start:
            self.window_start = current_window
            self.count = 0
        
        if self.count + tokens <= self.limit:
            self.count += tokens
            
            return {
                'allowed': True,
                'limit': self.limit,
                'remaining': self.limit - self.count,
                'reset_at': self.window_start + self.window_size
            }
        
        return {
            'allowed': False,
            'limit': self.limit,
            'remaining': 0,
            'reset_at': self.window_start + self.window_size,
            'retry_after': self.window_start + self.window_size - time.time()
        }
```

### Redis Implementation

```typescript
// Simple Redis-based fixed window
async function fixedWindowRedis(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSize: number
): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (windowSize * 1000));
  const redisKey = `rate:${key}:${window}`;

  const count = await redis.incr(redisKey);
  
  if (count === 1) {
    // First request in window - set expiry
    await redis.expire(redisKey, windowSize * 2);
  }

  return count <= limit;
}
```

### Redis Lua Script (Atomic)

```lua
-- KEYS[1]: rate limiter key
-- ARGV[1]: limit
-- ARGV[2]: window_size
-- ARGV[3]: current_time

local limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local window = math.floor(now / window_size)
local key = KEYS[1] .. ':' .. window

local count = redis.call('INCR', key)

if count == 1 then
    redis.call('EXPIRE', key, window_size * 2)
end

local allowed = count <= limit
local remaining = math.max(0, limit - count)
local reset_at = (window + 1) * window_size

return {allowed and 1 or 0, remaining, reset_at}
```

## Configuration Examples

### High-Frequency API (per second)

```typescript
const limiter = new FixedWindowLimiter(
  1,    // 1 second window
  100   // 100 requests per second
);
```

### Standard API (per minute)

```typescript
const limiter = new FixedWindowLimiter(
  60,   // 60 second window
  1000  // 1000 requests per minute
);
```

### Low-Frequency API (per hour)

```typescript
const limiter = new FixedWindowLimiter(
  3600, // 1 hour window
  10000 // 10,000 requests per hour
);
```

### Login Protection (per 15 minutes)

```typescript
const limiter = new FixedWindowLimiter(
  900,  // 15 minutes
  5     // 5 login attempts
);
```

## The Boundary Problem Explained

### Problem Scenario

```
Limit: 100 requests per minute

Timeline:
00:00:00 - Window 1 starts
00:00:59 - Client makes 100 requests (✓ allowed)
00:01:00 - Window 2 starts, counter resets
00:01:01 - Client makes 100 requests (✓ allowed)

Result: 200 requests in 2 seconds!
Expected: 100 requests per 60 seconds
```

### Impact Analysis

```typescript
// Best case (uniform distribution)
Actual rate = target rate

// Worst case (boundary exploitation)
Actual rate = 2 × target rate

// Typical case
Actual rate = 1.2-1.5 × target rate
```

### Mitigation Strategies

**1. Use Shorter Windows**
```typescript
// Instead of 1 window of 60s
const limiter = new FixedWindowLimiter(60, 100);

// Use multiple shorter windows
const limiters = [
  new FixedWindowLimiter(1, 2),    // 2/second
  new FixedWindowLimiter(60, 100)  // 100/minute
];
```

**2. Add Safety Buffer**
```typescript
// Reduce limit by 20% to account for boundary issues
const actualLimit = Math.floor(desiredLimit * 0.8);
const limiter = new FixedWindowLimiter(60, actualLimit);
```

**3. Switch to Sliding Window**
```typescript
// Eliminates boundary problem
const limiter = new SlidingWindowCounterLimiter(60, 100);
```

## Use Cases

### Ideal For:

1. **Internal APIs**: Where approximate limiting is acceptable
2. **Low Traffic**: Boundary problem is minimal
3. **Resource Constrained**: Minimal memory/CPU available
4. **Simple Requirements**: Don't need precise rate limiting
5. **Learning**: Understanding basic rate limiting concepts

### Not Ideal For:

1. **Public APIs**: Boundary exploitation possible
2. **High Security**: Need precise limits
3. **Critical Systems**: Can't tolerate spikes
4. **Billing/Metering**: Inaccuracy is unacceptable

### Real-World Examples

**GitHub API (older implementation)**
```typescript
// Simple fixed window
const limiter = new FixedWindowLimiter(3600, 5000);
```

**Internal Microservices**
```typescript
// Between trusted services
const limiter = new FixedWindowLimiter(60, 10000);
```

**Simple Throttling**
```typescript
// Basic protection against spam
const limiter = new FixedWindowLimiter(1, 10);
```

## Testing

### Test Cases

```typescript
describe('FixedWindowLimiter', () => {
  test('should allow requests within limit', () => {
    const limiter = new FixedWindowLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - i - 1);
    }
  });

  test('should reject requests over limit', () => {
    const limiter = new FixedWindowLimiter(60, 10);
    
    // Use up limit
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Should reject
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('should reset at window boundary', async () => {
    const limiter = new FixedWindowLimiter(1, 5);
    
    // Fill window
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    // Wait for new window
    await sleep(1100);
    
    // Should allow again
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
  });

  test('should demonstrate boundary problem', async () => {
    const limiter = new FixedWindowLimiter(1, 100);
    
    // At 0.9s, make 100 requests
    await sleep(900);
    for (let i = 0; i < 100; i++) {
      expect(limiter.allowRequest().allowed).toBe(true);
    }
    
    // At 1.1s, make 100 more (new window)
    await sleep(200);
    for (let i = 0; i < 100; i++) {
      expect(limiter.allowRequest().allowed).toBe(true);
    }
    
    // 200 requests in ~0.2 seconds!
  });
});
```

## Performance Characteristics

### Time Complexity
- Allow request: O(1)
- All operations: O(1)

### Space Complexity
- Per identifier: O(1) - single counter
- For 1M users: ~16 MB

### Throughput
```
Theoretical: Unlimited (O(1) operations)
Practical: 10M+ requests/second per instance
```

## Comparison with Other Algorithms

| Metric | Fixed Window | Sliding Window | Token Bucket |
|--------|--------------|----------------|--------------|
| Accuracy | 60-80% | 98-99% | 95% |
| Boundary Issue | ✅ Yes | ❌ No | ❌ No |
| Memory | 16 bytes | 32 bytes | 24 bytes |
| CPU | Lowest | Low | Low |
| Implementation | Easiest | Easy | Medium |
| Burst Support | Limited | Limited | Excellent |

## Improvements and Variations

### 1. Fixed Window with Buffer

Add safety margin:

```typescript
class BufferedFixedWindow extends FixedWindowLimiter {
  private buffer: number = 0.2; // 20% buffer

  allowRequest(): RateLimitResult {
    const effectiveLimit = Math.floor(this.limit * (1 - this.buffer));
    // Use effectiveLimit instead of this.limit
  }
}
```

### 2. Multiple Fixed Windows

Different limits for different time scales:

```typescript
class MultiWindowLimiter {
  private limiters = [
    new FixedWindowLimiter(1, 10),      // 10/second
    new FixedWindowLimiter(60, 100),    // 100/minute
    new FixedWindowLimiter(3600, 1000)  // 1000/hour
  ];

  allowRequest(): boolean {
    return this.limiters.every(limiter => 
      limiter.allowRequest().allowed
    );
  }
}
```

### 3. Progressive Fixed Window

Reduce limit as window progresses:

```typescript
class ProgressiveFixedWindow {
  allowRequest(): RateLimitResult {
    const elapsed = Date.now() - this.windowStart;
    const progress = elapsed / this.windowSize;
    
    // Reduce effective limit as window progresses
    const effectiveLimit = Math.floor(
      this.limit * (1 - progress * 0.2)
    );
    
    return this.count < effectiveLimit;
  }
}
```

## Monitoring

### Key Metrics

```typescript
interface FixedWindowMetrics {
  windowsProcessed: number;
  averageUtilization: number;
  peakUtilization: number;
  boundarySpikes: number;
  rejectionRate: number;
}
```

### Logging

```typescript
class MonitoredFixedWindow extends FixedWindowLimiter {
  allowRequest(): RateLimitResult {
    const result = super.allowRequest();
    
    // Log high utilization
    if (this.count / this.limit > 0.9) {
      console.warn(`High utilization: ${this.count}/${this.limit}`);
    }
    
    // Log boundary transitions
    if (this.getCurrentWindow() !== this.windowStart) {
      console.info(`Window transition: ${this.count} requests processed`);
    }
    
    return result;
  }
}
```

## When to Use Fixed Window

### ✅ Good Choice When:

- Simplicity is paramount
- Approximate limiting is acceptable
- Low resource environment
- Internal/trusted users
- Learning rate limiting concepts

### ❌ Poor Choice When:

- Need precise rate limiting
- Public API with untrusted users
- Boundary exploitation is a concern
- Billing/metering based on usage
- High security requirements

## Migration Path

### From Fixed Window to Better Algorithms

```typescript
// Start: Fixed Window (simple)
const v1 = new FixedWindowLimiter(60, 100);

// Upgrade: Sliding Window Counter (better accuracy)
const v2 = new SlidingWindowCounterLimiter(60, 100);

// Optimize: Token Bucket (burst support)
const v3 = new TokenBucketLimiter(100, 100/60);
```

## References

- [Rate Limiting Fundamentals](https://www.keycdn.com/support/rate-limiting)
- [API Rate Limiting Strategies](https://cloud.google.com/solutions/rate-limiting-strategies-techniques)
- [Redis Rate Limiting](https://redis.io/docs/reference/patterns/distributed-locks/)
