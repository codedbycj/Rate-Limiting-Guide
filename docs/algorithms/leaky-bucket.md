# Leaky Bucket Algorithm

## Overview

The Leaky Bucket algorithm is a traffic shaping technique that processes requests at a constant rate, regardless of how they arrive. Requests "leak out" of the bucket at a steady rate, smoothing bursts into a uniform flow.

## How It Works

Imagine a bucket with a small hole at the bottom:
1. Requests enter the bucket from the top
2. The bucket has a maximum capacity (queue size)
3. Requests leak out through the hole at a constant rate
4. If the bucket is full, new requests are rejected
5. Requests are processed in FIFO order

### Visual Representation

```
        Incoming Requests
              ↓ ↓ ↓
        ┌─────────────┐
        │  Request 5  │
        │  Request 4  │  ← Bucket (capacity)
        │  Request 3  │
        │  Request 2  │
        │  Request 1  │
        └──────╲──────┘
                ╲
                 ╲ ← Leak (constant rate)
                  ╲
            Processed Requests
```

## Algorithm Details

### Parameters

- **Capacity (C)**: Maximum number of requests the bucket can hold
- **Leak Rate (R)**: Rate at which requests are processed (requests per second)
- **Queue**: FIFO queue of pending requests

### Pseudocode

```
class LeakyBucket:
    capacity: int
    leak_rate: float  # requests per second
    queue: Queue
    last_leak: timestamp

    function allow_request():
        leak_pending_requests()
        
        if queue.size() < capacity:
            queue.enqueue(current_time())
            return True
        else:
            return False
    
    function leak_pending_requests():
        now = current_time()
        elapsed = now - last_leak
        requests_to_leak = floor(elapsed * leak_rate)
        
        for i in range(min(requests_to_leak, queue.size())):
            queue.dequeue()
        
        last_leak = now
```

## Characteristics

### Advantages

1. **Strict Output Rate**: Guarantees constant processing rate
2. **Traffic Smoothing**: Converts bursts into steady flow
3. **Predictable**: Downstream services see uniform traffic
4. **Fair**: FIFO processing ensures fairness
5. **Simple to Understand**: Intuitive bucket metaphor

### Disadvantages

1. **No Burst Support**: Cannot handle bursts efficiently
2. **Potential Latency**: Requests may wait in queue
3. **Queue Management**: Need to handle queue overflow
4. **Less Flexible**: Cannot adapt to varying loads
5. **Implementation Complexity**: More complex than fixed window

## Implementation

### TypeScript Implementation

```typescript
class LeakyBucketLimiter {
  private capacity: number;
  private leakRate: number; // requests per second
  private queue: number[];
  private lastLeak: number;

  constructor(capacity: number, leakRate: number) {
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

    return {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      resetAt: Date.now() + retryAfter,
      retryAfter: retryAfter / 1000
    };
  }
}
```

### Python Implementation

```python
import time
from collections import deque
from dataclasses import dataclass

@dataclass
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_at: float
    retry_after: float = None

class LeakyBucketLimiter:
    def __init__(self, capacity: int, leak_rate: float):
        self.capacity = capacity
        self.leak_rate = leak_rate  # requests per second
        self.queue = deque()
        self.last_leak = time.time()
    
    def _leak(self):
        now = time.time()
        elapsed = now - self.last_leak
        requests_to_leak = int(elapsed * self.leak_rate)
        
        for _ in range(min(requests_to_leak, len(self.queue))):
            self.queue.popleft()
        
        self.last_leak = now
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        self._leak()
        
        if len(self.queue) + tokens <= self.capacity:
            for _ in range(tokens):
                self.queue.append(time.time())
            
            return RateLimitResult(
                allowed=True,
                limit=self.capacity,
                remaining=self.capacity - len(self.queue),
                reset_at=time.time() + len(self.queue) / self.leak_rate
            )
        
        retry_after = (len(self.queue) - self.capacity + tokens) / self.leak_rate
        
        return RateLimitResult(
            allowed=False,
            limit=self.capacity,
            remaining=0,
            reset_at=time.time() + retry_after,
            retry_after=retry_after
        )
```

### Redis Implementation (Lua Script)

```lua
-- KEYS[1]: bucket key
-- ARGV[1]: capacity
-- ARGV[2]: leak_rate
-- ARGV[3]: tokens_requested
-- ARGV[4]: current_time

local capacity = tonumber(ARGV[1])
local leak_rate = tonumber(ARGV[2])
local tokens_requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Get bucket state
local bucket = redis.call('LRANGE', KEYS[1], 0, -1)
local last_leak = tonumber(redis.call('GET', KEYS[1] .. ':last_leak') or now)

-- Leak old requests
local elapsed = math.max(0, now - last_leak)
local requests_to_leak = math.floor(elapsed * leak_rate)

for i = 1, math.min(requests_to_leak, #bucket) do
    redis.call('LPOP', KEYS[1])
end

-- Get current size
local queue_size = redis.call('LLEN', KEYS[1])

local allowed = 0
local remaining = capacity

if queue_size + tokens_requested <= capacity then
    -- Add new requests
    for i = 1, tokens_requested do
        redis.call('RPUSH', KEYS[1], now)
    end
    allowed = 1
    remaining = capacity - queue_size - tokens_requested
else
    remaining = 0
end

-- Update last leak time
redis.call('SET', KEYS[1] .. ':last_leak', now)
redis.call('EXPIRE', KEYS[1], 3600)
redis.call('EXPIRE', KEYS[1] .. ':last_leak', 3600)

return {allowed, remaining}
```

## Configuration Examples

### Conservative (Strict Rate)

```typescript
const limiter = new LeakyBucketLimiter(
  10,   // Small capacity
  1     // Slow leak rate (1 req/sec)
);
```
- Processes 1 request per second
- Queue up to 10 requests

### Moderate (Balanced)

```typescript
const limiter = new LeakyBucketLimiter(
  100,  // Medium capacity
  10    // Moderate leak rate (10 req/sec)
);
```
- Processes 10 requests per second
- Queue up to 100 requests

### Permissive (High Throughput)

```typescript
const limiter = new LeakyBucketLimiter(
  1000, // Large capacity
  100   // Fast leak rate (100 req/sec)
);
```
- Processes 100 requests per second
- Queue up to 1000 requests

## Use Cases

### Ideal For:

1. **Protecting Downstream Services**: Ensure backend never gets overloaded
2. **Network Traffic Shaping**: QoS in routers and switches
3. **API Gateway**: Smooth traffic to backend microservices
4. **Message Queue Processing**: Steady consumption rate
5. **Database Write Protection**: Prevent write spikes

### Real-World Examples:

**Network Routers**
```typescript
// QoS traffic shaping
const qos = new LeakyBucketLimiter(
  1000,  // 1000 packet queue
  100    // 100 packets/sec
);
```

**API Gateway**
```typescript
// Smooth requests to backend
const gateway = new LeakyBucketLimiter(
  500,   // Queue 500 requests
  50     // Process 50/sec
);
```

**Database Write Limiter**
```typescript
// Protect database from write bursts
const dbLimiter = new LeakyBucketLimiter(
  100,   // Queue 100 writes
  10     // Write 10/sec
);
```

## Comparison with Token Bucket

| Feature | Leaky Bucket | Token Bucket |
|---------|--------------|--------------|
| Output Rate | **Strict/Constant** | Variable |
| Burst Support | ❌ No | ✅ Yes |
| Use Case | Traffic shaping | Rate limiting |
| Queue | ✅ Yes | ❌ No |
| Predictability | Very High | Medium |
| Downstream Protection | Excellent | Good |

### When to Choose Leaky Bucket

Choose Leaky Bucket when:
- Downstream service requires constant rate
- You want to smooth traffic bursts
- Predictable processing rate is critical
- You can tolerate request queuing

Choose Token Bucket when:
- Need to allow bursts
- Want more flexibility
- Low latency is critical
- No queuing acceptable

## Variations

### 1. Leaky Bucket as a Meter

Instead of queueing, immediately reject:

```typescript
class LeakyBucketMeter {
  private water: number = 0;
  private lastCheck: number = Date.now();

  allowRequest(): boolean {
    this.leak();
    
    if (this.water + 1 <= this.capacity) {
      this.water += 1;
      return true;
    }
    return false;
  }

  private leak(): void {
    const now = Date.now();
    const elapsed = (now - this.lastCheck) / 1000;
    const leaked = elapsed * this.leakRate;
    
    this.water = Math.max(0, this.water - leaked);
    this.lastCheck = now;
  }
}
```

### 2. Priority Leaky Bucket

Different priorities for different requests:

```typescript
class PriorityLeakyBucket {
  private highPriorityQueue: number[] = [];
  private lowPriorityQueue: number[] = [];

  allowRequest(priority: 'high' | 'low'): boolean {
    this.leak();
    
    const totalSize = this.highPriorityQueue.length + 
                     this.lowPriorityQueue.length;
    
    if (totalSize < this.capacity) {
      if (priority === 'high') {
        this.highPriorityQueue.push(Date.now());
      } else {
        this.lowPriorityQueue.push(Date.now());
      }
      return true;
    }
    return false;
  }

  private leak(): void {
    // Leak from high priority first
    if (this.highPriorityQueue.length > 0) {
      this.highPriorityQueue.shift();
    } else if (this.lowPriorityQueue.length > 0) {
      this.lowPriorityQueue.shift();
    }
  }
}
```

## Testing

### Test Cases

```typescript
describe('LeakyBucketLimiter', () => {
  test('should allow requests up to capacity', () => {
    const limiter = new LeakyBucketLimiter(10, 2);
    
    for (let i = 0; i < 10; i++) {
      expect(limiter.allowRequest().allowed).toBe(true);
    }
    
    expect(limiter.allowRequest().allowed).toBe(false);
  });

  test('should leak requests over time', async () => {
    const limiter = new LeakyBucketLimiter(10, 5);
    
    // Fill bucket
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Wait 1 second (should leak 5)
    await sleep(1000);
    
    // Should allow 5 more
    for (let i = 0; i < 5; i++) {
      expect(limiter.allowRequest().allowed).toBe(true);
    }
  });

  test('should maintain FIFO order', () => {
    const limiter = new LeakyBucketLimiter(5, 1);
    
    const timestamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
      timestamps.push(Date.now());
    }
    
    // Verify order is maintained
    expect(limiter.getQueue()).toEqual(timestamps);
  });
});
```

## Performance Characteristics

### Time Complexity
- Allow request: O(N) where N = requests to leak
- Optimized: O(1) with timestamp tracking

### Space Complexity
- O(N) where N = queue size
- Scales with capacity setting

### Throughput
```
Maximum throughput = leak_rate
Average latency = queue_size / (2 × leak_rate)
```

## Advanced Topics

### Adaptive Leak Rate

Adjust leak rate based on system load:

```typescript
class AdaptiveLeakyBucket {
  private baseLeakRate: number;
  private currentLeakRate: number;

  adjustLeakRate(systemLoad: number): void {
    if (systemLoad > 0.8) {
      // Reduce rate when system is stressed
      this.currentLeakRate = this.baseLeakRate * 0.7;
    } else if (systemLoad < 0.5) {
      // Increase rate when system is idle
      this.currentLeakRate = this.baseLeakRate * 1.3;
    } else {
      this.currentLeakRate = this.baseLeakRate;
    }
  }
}
```

### Monitoring Metrics

Key metrics to track:

```typescript
interface LeakyBucketMetrics {
  queueSize: number;
  leakRate: number;
  averageWaitTime: number;
  rejectionRate: number;
  utilization: number;
}
```

## References

- [Generic Cell Rate Algorithm](https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm)
- [Traffic Shaping](https://en.wikipedia.org/wiki/Traffic_shaping)
- [Queuing Theory](https://en.wikipedia.org/wiki/Queueing_theory)
- [Network QoS](https://www.cisco.com/c/en/us/support/docs/quality-of-service-qos/qos-policing/22833-qos-faq.html)
