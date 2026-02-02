# Token Bucket Algorithm

## Overview

The Token Bucket algorithm is one of the most popular and flexible rate limiting techniques. It allows for bursts of traffic while maintaining an average rate limit over time.

## How It Works

Imagine a bucket that:
1. Has a maximum capacity of tokens
2. Tokens are added to the bucket at a fixed rate
3. Each request consumes one (or more) tokens
4. If the bucket has enough tokens, the request is allowed
5. If not enough tokens, the request is rejected or queued

### Visual Representation

```
           Tokens Added
           at Fixed Rate
                 ↓
        ┌─────────────────┐
        │                 │
        │   🪙 🪙 🪙 🪙   │  ← Bucket (max capacity)
        │   🪙 🪙 🪙      │
        └─────────────────┘
                 ↓
           Tokens Consumed
           by Requests
```

## Algorithm Details

### Parameters

- **Capacity (C)**: Maximum number of tokens in the bucket
- **Refill Rate (R)**: Rate at which tokens are added (tokens per second)
- **Current Tokens (T)**: Number of tokens currently in the bucket

### Pseudocode

```
class TokenBucket:
    capacity: int
    refill_rate: float  # tokens per second
    tokens: float
    last_refill: timestamp

    function allow_request(tokens_requested=1):
        refill_tokens()
        
        if tokens >= tokens_requested:
            tokens -= tokens_requested
            return True
        else:
            return False
    
    function refill_tokens():
        now = current_time()
        elapsed = now - last_refill
        tokens_to_add = elapsed * refill_rate
        
        tokens = min(capacity, tokens + tokens_to_add)
        last_refill = now
```

## Characteristics

### Advantages

1. **Handles Bursts**: Allows bursts up to the bucket capacity
2. **Smooth Rate**: Maintains average rate over time
3. **Memory Efficient**: Only stores a few numbers per bucket
4. **Flexible**: Can configure capacity and rate independently

### Disadvantages

1. **Burst Potential**: May allow sudden traffic spikes
2. **Complexity**: Slightly more complex than fixed window
3. **Tuning Required**: Need to set both capacity and rate

## Configuration Examples

### Conservative (Strict Rate)

```yaml
capacity: 10
refill_rate: 10  # 10 tokens/second
```
- Allows 10 req/s average
- Small burst of 10 requests

### Moderate (Balanced)

```yaml
capacity: 100
refill_rate: 50  # 50 tokens/second
```
- Allows 50 req/s average
- Can handle burst of 100 requests

### Permissive (High Burst)

```yaml
capacity: 1000
refill_rate: 100  # 100 tokens/second
```
- Allows 100 req/s average
- Large burst capacity of 1000 requests

## Use Cases

### Ideal For:

1. **API Rate Limiting**: Allow normal usage with occasional bursts
2. **Traffic Shaping**: Smooth out traffic to backend services
3. **User Quotas**: Different tiers with different bucket sizes
4. **Network QoS**: Bandwidth management

### Not Ideal For:

1. **Strict Guarantees**: When you need exactly N requests per window
2. **Predictable Patterns**: When fixed windows are sufficient

## Implementation Considerations

### In-Memory Implementation

```python
import time
import threading

class TokenBucket:
    def __init__(self, capacity, refill_rate):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = capacity
        self.last_refill = time.time()
        self.lock = threading.Lock()
    
    def _refill(self):
        now = time.time()
        elapsed = now - self.last_refill
        tokens_to_add = elapsed * self.refill_rate
        self.tokens = min(self.capacity, self.tokens + tokens_to_add)
        self.last_refill = now
    
    def consume(self, tokens=1):
        with self.lock:
            self._refill()
            if self.tokens >= tokens:
                self.tokens -= tokens
                return True
            return False
```

### Redis Implementation (Lua Script)

```lua
-- KEYS[1]: bucket key
-- ARGV[1]: capacity
-- ARGV[2]: refill_rate
-- ARGV[3]: tokens_requested
-- ARGV[4]: current_time

local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local tokens_requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill')
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

-- Update bucket
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', KEYS[1], 3600)  -- 1 hour TTL

return {allowed, tokens}
```

## Advanced Variations

### 1. Hierarchical Token Bucket

Multiple buckets for different rate limits:
```
Global Bucket (1000 req/min)
    ├── User Bucket (100 req/min)
    └── IP Bucket (200 req/min)
```

### 2. Token Bucket with Debt

Allow going into "debt" and recover:
```python
def consume_with_debt(self, tokens=1, max_debt=10):
    if self.tokens >= tokens:
        self.tokens -= tokens
        return True, 0
    elif self.tokens + max_debt >= tokens:
        debt = tokens - self.tokens
        self.tokens = 0
        return True, debt
    return False, 0
```

### 3. Adaptive Token Bucket

Adjust rate based on system load:
```python
def adjust_rate(self, system_load):
    if system_load > 0.8:
        self.refill_rate *= 0.9  # Reduce by 10%
    elif system_load < 0.5:
        self.refill_rate *= 1.1  # Increase by 10%
```

## Comparison with Other Algorithms

| Feature | Token Bucket | Leaky Bucket | Fixed Window |
|---------|-------------|--------------|--------------|
| Burst Support | ✅ Good | ❌ None | ⚠️ Limited |
| Memory | Low | Low | Very Low |
| Accuracy | High | Very High | Medium |
| Implementation | Medium | Easy | Easy |
| Fairness | Good | Excellent | Poor |

## Real-World Examples

### AWS API Gateway
Uses token bucket for throttling with:
- Burst capacity: 5000 requests
- Steady rate: 10000 req/s

### Stripe API
Implements token bucket with:
- Different rates per API endpoint
- User-specific bucket sizes based on plan

### Google Cloud
Uses token bucket for:
- Quota management
- QoS classes
- Burst allowances

## Testing

### Test Cases

1. **Normal Rate**: Request at steady rate under limit
2. **Burst Test**: Send burst up to capacity
3. **Refill Test**: Verify token refill over time
4. **Overflow Test**: Tokens don't exceed capacity
5. **Concurrent Test**: Thread-safe operations

### Example Test

```python
def test_burst_then_steady():
    bucket = TokenBucket(capacity=100, refill_rate=10)
    
    # Burst: should allow 100 requests
    for i in range(100):
        assert bucket.consume() == True
    
    # 101st should fail
    assert bucket.consume() == False
    
    # Wait 1 second (10 tokens refilled)
    time.sleep(1)
    
    # Should allow 10 more
    for i in range(10):
        assert bucket.consume() == True
    
    # 11th should fail
    assert bucket.consume() == False
```

## References

- [Token Bucket - Wikipedia](https://en.wikipedia.org/wiki/Token_bucket)
- [GCRA Algorithm](https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm)
- [Guava RateLimiter](https://github.com/google/guava/blob/master/guava/src/com/google/common/util/concurrent/RateLimiter.java)
