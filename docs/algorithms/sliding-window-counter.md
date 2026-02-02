# Sliding Window Counter Algorithm

## Overview

The Sliding Window Counter algorithm is a hybrid approach that combines the memory efficiency of fixed windows with the accuracy of sliding window logs. It's one of the most practical algorithms for production systems.

## How It Works

The algorithm maintains counters for fixed time windows but smoothly transitions between them by considering both the current and previous window.

### Visual Representation

```
Previous Window        Current Window
[-------------]        [-------------]
   60 requests            20 requests
                ↑
            Current Time
            (30% into current window)

Effective Count = (70% × 60) + (100% × 20) = 42 + 20 = 62 requests
```

## Algorithm Details

### Key Concept

Instead of tracking every individual request (like sliding window log), we:
1. Keep counters for fixed time windows
2. When checking the rate, calculate a weighted sum:
   - Weight from previous window based on overlap
   - Full weight from current window

### Formula

```
current_rate = previous_count × overlap_percentage + current_count

where:
overlap_percentage = (window_size - elapsed_time) / window_size
```

### Pseudocode

```
class SlidingWindowCounter:
    window_size: int  # in seconds
    limit: int
    current_window: {start_time, count}
    previous_window: {start_time, count}

    function allow_request():
        now = current_time()
        window_start = floor(now / window_size) * window_size
        
        # Check if we're in a new window
        if window_start != current_window.start_time:
            previous_window = current_window
            current_window = {start_time: window_start, count: 0}
        
        # Calculate rate
        elapsed = now - current_window.start_time
        overlap_pct = (window_size - elapsed) / window_size
        estimated_count = (previous_window.count * overlap_pct) + 
                         current_window.count
        
        if estimated_count < limit:
            current_window.count += 1
            return True
        else:
            return False
```

## Characteristics

### Advantages

1. **Memory Efficient**: Only stores 2 counters per identifier
2. **Good Accuracy**: Smoother than fixed window
3. **No Boundary Issues**: Reduces spike at window boundaries
4. **Fast**: O(1) time complexity
5. **Practical**: Good balance for production use

### Disadvantages

1. **Approximate**: Not 100% accurate (but very close)
2. **Slight Bias**: Can allow slightly more than limit
3. **Assumes Uniform Distribution**: Works best with even traffic

## Mathematical Analysis

### Error Bounds

Maximum error occurs when all requests happen at window boundaries:
- **Best case**: 0% error (uniform distribution)
- **Worst case**: ~0.01% error in most scenarios
- **Typical case**: < 0.1% error

### Comparison to Exact Count

```
Time:     0s   10s  20s  30s  40s  50s  60s  70s  80s  90s
Requests: 50   0    0    0    0    0    50   0    0    0

Exact Sliding (at 65s, 60s window):
- Counts: 50 requests from [5s-65s]

Sliding Window Counter (at 65s):
- Previous: 50 (0-60s)
- Current: 50 (60-120s)
- Overlap: 83.3% of previous
- Estimate: (50 × 0.833) + 50 = 91.65 ≈ 92

Actual in window [5s-65s]: 50
Error: ~84% (worst case scenario)
```

For normal traffic (not concentrated at boundaries), error is typically < 1%.

## Implementation

### Python Implementation

```python
import time
import threading

class SlidingWindowCounter:
    def __init__(self, window_size, limit):
        """
        Args:
            window_size: Size of the window in seconds
            limit: Maximum number of requests per window
        """
        self.window_size = window_size
        self.limit = limit
        self.current_window = {'start': 0, 'count': 0}
        self.previous_window = {'start': 0, 'count': 0}
        self.lock = threading.Lock()
    
    def allow_request(self):
        with self.lock:
            now = time.time()
            window_start = int(now // self.window_size) * self.window_size
            
            # Move to new window if needed
            if window_start != self.current_window['start']:
                self.previous_window = self.current_window.copy()
                self.current_window = {'start': window_start, 'count': 0}
            
            # Calculate estimated count
            elapsed = now - self.current_window['start']
            overlap_pct = (self.window_size - elapsed) / self.window_size
            
            estimated_count = (
                self.previous_window['count'] * overlap_pct +
                self.current_window['count']
            )
            
            if estimated_count < self.limit:
                self.current_window['count'] += 1
                return True
            
            return False
    
    def get_remaining(self):
        """Get approximate remaining requests"""
        with self.lock:
            now = time.time()
            elapsed = now - self.current_window['start']
            overlap_pct = (self.window_size - elapsed) / self.window_size
            
            estimated_count = (
                self.previous_window['count'] * overlap_pct +
                self.current_window['count']
            )
            
            return max(0, self.limit - int(estimated_count))
```

### Redis Implementation (Lua Script)

```lua
-- KEYS[1]: rate_limiter:{identifier}
-- ARGV[1]: window_size (seconds)
-- ARGV[2]: limit
-- ARGV[3]: current_timestamp

local window_size = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local window_start = math.floor(now / window_size) * window_size
local prev_window_start = window_start - window_size

-- Get current and previous window counts
local current = redis.call('GET', KEYS[1] .. ':' .. window_start) or 0
local previous = redis.call('GET', KEYS[1] .. ':' .. prev_window_start) or 0

current = tonumber(current)
previous = tonumber(previous)

-- Calculate estimated count
local elapsed = now - window_start
local overlap_pct = (window_size - elapsed) / window_size
local estimated_count = (previous * overlap_pct) + current

local allowed = 0
local remaining = limit

if estimated_count < limit then
    -- Increment current window
    redis.call('INCR', KEYS[1] .. ':' .. window_start)
    redis.call('EXPIRE', KEYS[1] .. ':' .. window_start, window_size * 2)
    allowed = 1
    remaining = limit - math.floor(estimated_count) - 1
else
    remaining = 0
end

return {allowed, remaining, math.floor(estimated_count)}
```

### Go Implementation

```go
package ratelimit

import (
    "sync"
    "time"
)

type SlidingWindowCounter struct {
    windowSize time.Duration
    limit      int64
    current    window
    previous   window
    mu         sync.Mutex
}

type window struct {
    start int64
    count int64
}

func NewSlidingWindowCounter(windowSize time.Duration, limit int64) *SlidingWindowCounter {
    return &SlidingWindowCounter{
        windowSize: windowSize,
        limit:      limit,
        current:    window{start: 0, count: 0},
        previous:   window{start: 0, count: 0},
    }
}

func (s *SlidingWindowCounter) Allow() bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now().Unix()
    windowStart := (now / int64(s.windowSize.Seconds())) * int64(s.windowSize.Seconds())

    // Move to new window if needed
    if windowStart != s.current.start {
        s.previous = s.current
        s.current = window{start: windowStart, count: 0}
    }

    // Calculate estimated count
    elapsed := float64(now - s.current.start)
    overlapPct := (float64(s.windowSize.Seconds()) - elapsed) / float64(s.windowSize.Seconds())
    estimatedCount := int64(float64(s.previous.count)*overlapPct) + s.current.count

    if estimatedCount < s.limit {
        s.current.count++
        return true
    }

    return false
}

func (s *SlidingWindowCounter) Remaining() int64 {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now().Unix()
    elapsed := float64(now - s.current.start)
    overlapPct := (float64(s.windowSize.Seconds()) - elapsed) / float64(s.windowSize.Seconds())
    estimatedCount := int64(float64(s.previous.count)*overlapPct) + s.current.count

    remaining := s.limit - estimatedCount
    if remaining < 0 {
        return 0
    }
    return remaining
}
```

## Use Cases

### Perfect For:

1. **High-Traffic APIs**: Efficient memory usage at scale
2. **Distributed Systems**: Easy to implement with Redis
3. **Multi-tier Rate Limiting**: Different limits per endpoint
4. **SaaS Platforms**: Per-user/per-tenant rate limiting

### Examples:

```python
# API rate limiting
api_limiter = SlidingWindowCounter(
    window_size=60,    # 1 minute
    limit=1000         # 1000 requests per minute
)

# Login attempts
login_limiter = SlidingWindowCounter(
    window_size=300,   # 5 minutes
    limit=5            # 5 attempts per 5 minutes
)

# Download quota
download_limiter = SlidingWindowCounter(
    window_size=3600,  # 1 hour
    limit=100          # 100 downloads per hour
)
```

## Configuration Strategies

### Conservative (Strict)
```yaml
window_size: 60      # 1 minute
limit: 100           # 100 req/min
buffer: 0%           # No buffer
```

### Standard (Recommended)
```yaml
window_size: 60      # 1 minute
limit: 1000          # 1000 req/min
buffer: 5%           # 5% buffer for estimation error
```

### Permissive (Lenient)
```yaml
window_size: 300     # 5 minutes
limit: 10000         # 10000 req/5min
buffer: 10%          # 10% buffer
```

## Advanced Features

### 1. Multi-Window Support

Track multiple time windows simultaneously:

```python
class MultiWindowCounter:
    def __init__(self, limits):
        # limits = {60: 100, 3600: 5000}  # 100/min, 5000/hour
        self.limiters = {
            window: SlidingWindowCounter(window, limit)
            for window, limit in limits.items()
        }
    
    def allow_request(self):
        return all(
            limiter.allow_request() 
            for limiter in self.limiters.values()
        )
```

### 2. Weighted Requests

Different requests consume different amounts:

```python
def allow_weighted(self, weight=1):
    """Allow request with custom weight"""
    # Check if we have capacity
    estimated = self._calculate_estimate()
    if estimated + weight <= self.limit:
        self.current_window['count'] += weight
        return True
    return False
```

### 3. Dynamic Limits

Adjust limits based on system state:

```python
def adjust_limit(self, factor):
    """Adjust limit by a factor (e.g., 0.5 for half)"""
    self.limit = int(self.limit * factor)
```

## Monitoring and Metrics

### Key Metrics to Track

1. **Request Rate**: Actual requests per second/minute
2. **Rejection Rate**: Percentage of rejected requests
3. **Window Utilization**: Current count / limit
4. **Estimation Error**: Difference from true sliding window

### Prometheus Metrics Example

```python
from prometheus_client import Counter, Gauge, Histogram

requests_total = Counter(
    'rate_limit_requests_total',
    'Total requests processed',
    ['identifier', 'allowed']
)

window_utilization = Gauge(
    'rate_limit_window_utilization',
    'Current window utilization',
    ['identifier']
)

def allow_request_with_metrics(self, identifier):
    allowed = self.allow_request()
    
    requests_total.labels(
        identifier=identifier,
        allowed=str(allowed)
    ).inc()
    
    utilization = (self.current_window['count'] / self.limit) * 100
    window_utilization.labels(identifier=identifier).set(utilization)
    
    return allowed
```

## Testing

### Test Scenarios

```python
import unittest
import time

class TestSlidingWindowCounter(unittest.TestCase):
    def test_allows_requests_under_limit(self):
        limiter = SlidingWindowCounter(window_size=1, limit=10)
        for _ in range(10):
            self.assertTrue(limiter.allow_request())
    
    def test_rejects_over_limit(self):
        limiter = SlidingWindowCounter(window_size=1, limit=10)
        for _ in range(10):
            limiter.allow_request()
        self.assertFalse(limiter.allow_request())
    
    def test_window_transition(self):
        limiter = SlidingWindowCounter(window_size=1, limit=10)
        for _ in range(10):
            limiter.allow_request()
        
        time.sleep(1.1)  # Move to next window
        self.assertTrue(limiter.allow_request())
    
    def test_sliding_behavior(self):
        limiter = SlidingWindowCounter(window_size=2, limit=100)
        
        # Fill window
        for _ in range(100):
            limiter.allow_request()
        
        time.sleep(1)  # Halfway through
        # Should allow ~50 more (due to 50% overlap)
        allowed = sum(1 for _ in range(60) if limiter.allow_request())
        self.assertGreater(allowed, 40)
        self.assertLess(allowed, 60)
```

## Performance Characteristics

### Time Complexity
- Allow request: O(1)
- Get remaining: O(1)

### Space Complexity
- Per identifier: O(1) - just 2 counters

### Throughput
Can handle millions of requests per second per instance with proper implementation.

## Comparison Table

| Metric | Fixed Window | Sliding Log | Sliding Counter |
|--------|--------------|-------------|-----------------|
| Accuracy | 60% | 100% | 98-99% |
| Memory per ID | 1 counter | N timestamps | 2 counters |
| CPU per request | Very Low | Medium | Low |
| Boundary spikes | Yes | No | Minimal |
| Implementation | Easy | Medium | Easy |

## References

- [CloudFlare Rate Limiting](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- [Figma's Rate Limiting](https://www.figma.com/blog/an-alternative-approach-to-rate-limiting/)
- [Kong Rate Limiting Plugin](https://docs.konghq.com/hub/kong-inc/rate-limiting/)
