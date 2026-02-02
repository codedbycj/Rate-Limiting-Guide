# Sliding Window Log Algorithm

## Overview

The Sliding Window Log algorithm maintains a log of timestamps for all requests within the time window. It provides the most accurate rate limiting by tracking exact request times, eliminating boundary issues completely.

## How It Works

1. Maintain a log (queue) of all request timestamps
2. For each new request, remove timestamps older than the window
3. If log size < limit, allow the request and add timestamp
4. Otherwise, reject the request

### Visual Representation

```
Window: 60 seconds
Current time: 100s

Request Log:
[45s, 52s, 61s, 75s, 83s, 92s, 98s]
         ↑
    Remove (older than 40s)

Final Log:
[52s, 61s, 75s, 83s, 92s, 98s] ← 6 requests in window
```

## Algorithm Details

### Pseudocode

```
class SlidingWindowLog:
    window_size: int
    limit: int
    requests: List[timestamp]

    function allow_request():
        now = current_time()
        cutoff = now - window_size
        
        # Remove old requests
        while requests.length > 0 AND requests[0] <= cutoff:
            requests.remove_first()
        
        if requests.length < limit:
            requests.append(now)
            return True
        else:
            return False
```

## Implementation

### TypeScript

```typescript
export class SlidingWindowLogLimiter {
  private windowSize: number;
  private limit: number;
  private requests: number[];

  constructor(windowSize: number, limit: number) {
    this.windowSize = windowSize * 1000;
    this.limit = limit;
    this.requests = [];
  }

  private removeOldRequests(): void {
    const now = Date.now();
    const cutoff = now - this.windowSize;
    
    while (this.requests.length > 0 && this.requests[0] <= cutoff) {
      this.requests.shift();
    }
  }

  allowRequest(): RateLimitResult {
    this.removeOldRequests();
    const now = Date.now();

    if (this.requests.length < this.limit) {
      this.requests.push(now);

      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - this.requests.length,
        resetAt: this.requests[0] + this.windowSize
      };
    }

    const oldestRequest = this.requests[0];
    const retryAfter = (oldestRequest + this.windowSize - now) / 1000;

    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt: oldestRequest + this.windowSize,
      retryAfter: Math.max(0, retryAfter)
    };
  }
}
```

### Redis (using Sorted Set)

```typescript
async function slidingWindowLogRedis(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSize: number
): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - (windowSize * 1000);

  const pipe = redis.pipeline();
  
  // Remove old entries
  pipe.zremrangebyscore(key, 0, cutoff);
  
  // Count current entries
  pipe.zcard(key);
  
  const results = await pipe.exec();
  const count = results[1][1];

  if (count < limit) {
    // Add new entry
    await redis.zadd(key, now, `${now}:${Math.random()}`);
    await redis.expire(key, windowSize * 2);
    return true;
  }

  return false;
}
```

## Characteristics

### Advantages
- 100% accurate
- No boundary issues
- True sliding window
- Fair to all requests

### Disadvantages
- High memory usage (O(N) per identifier)
- Slower than counter-based algorithms
- Not suitable for high traffic

### Memory Usage
```
10,000 req/min × 8 bytes = 80 KB per user
1M users = 80 GB!
```

## Use Cases

Best for:
- Financial systems
- Compliance-heavy applications
- Low-medium traffic APIs
- When perfect accuracy required

## Performance

- Time: O(N) for cleanup
- Space: O(limit) per identifier
- Practical limit: ~1000 req/window per user

## References
- [Precise Rate Limiting](https://konghq.com/blog/how-to-design-a-scalable-rate-limiting-algorithm)
