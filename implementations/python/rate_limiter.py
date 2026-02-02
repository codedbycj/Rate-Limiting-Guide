"""
Rate Limiting Library - Python Implementation

Provides multiple rate limiting algorithms:
- Token Bucket
- Leaky Bucket
- Fixed Window Counter
- Sliding Window Log
- Sliding Window Counter
"""

import time
import threading
from collections import deque
from abc import ABC, abstractmethod
from typing import Optional, Dict, List
from dataclasses import dataclass


@dataclass
class RateLimitResult:
    """Result of a rate limit check"""
    allowed: bool
    limit: int
    remaining: int
    reset_at: float
    retry_after: Optional[float] = None


class RateLimiter(ABC):
    """Abstract base class for rate limiters"""
    
    @abstractmethod
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        """Check if request is allowed"""
        pass
    
    @abstractmethod
    def reset(self):
        """Reset the rate limiter"""
        pass


class TokenBucketLimiter(RateLimiter):
    """
    Token Bucket Algorithm
    
    Tokens are added at a constant rate. Each request consumes tokens.
    Allows bursts up to bucket capacity.
    
    Args:
        capacity: Maximum number of tokens in bucket
        refill_rate: Tokens added per second
    """
    
    def __init__(self, capacity: int, refill_rate: float):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = float(capacity)
        self.last_refill = time.time()
        self.lock = threading.Lock()
    
    def _refill(self):
        """Add tokens based on elapsed time"""
        now = time.time()
        elapsed = now - self.last_refill
        tokens_to_add = elapsed * self.refill_rate
        self.tokens = min(self.capacity, self.tokens + tokens_to_add)
        self.last_refill = now
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
            self._refill()
            
            if self.tokens >= tokens:
                self.tokens -= tokens
                return RateLimitResult(
                    allowed=True,
                    limit=self.capacity,
                    remaining=int(self.tokens),
                    reset_at=time.time() + (self.capacity - self.tokens) / self.refill_rate
                )
            else:
                # Calculate when enough tokens will be available
                tokens_needed = tokens - self.tokens
                retry_after = tokens_needed / self.refill_rate
                
                return RateLimitResult(
                    allowed=False,
                    limit=self.capacity,
                    remaining=0,
                    reset_at=time.time() + retry_after,
                    retry_after=retry_after
                )
    
    def reset(self):
        with self.lock:
            self.tokens = float(self.capacity)
            self.last_refill = time.time()


class LeakyBucketLimiter(RateLimiter):
    """
    Leaky Bucket Algorithm
    
    Requests are added to a queue and processed at a constant rate.
    Enforces strict output rate.
    
    Args:
        capacity: Maximum queue size
        leak_rate: Requests processed per second
    """
    
    def __init__(self, capacity: int, leak_rate: float):
        self.capacity = capacity
        self.leak_rate = leak_rate
        self.queue = deque()
        self.last_leak = time.time()
        self.lock = threading.Lock()
    
    def _leak(self):
        """Process requests from queue"""
        now = time.time()
        elapsed = now - self.last_leak
        requests_to_leak = int(elapsed * self.leak_rate)
        
        for _ in range(min(requests_to_leak, len(self.queue))):
            self.queue.popleft()
        
        self.last_leak = now
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
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
            else:
                return RateLimitResult(
                    allowed=False,
                    limit=self.capacity,
                    remaining=0,
                    reset_at=time.time() + (len(self.queue) - self.capacity) / self.leak_rate,
                    retry_after=(len(self.queue) - self.capacity + tokens) / self.leak_rate
                )
    
    def reset(self):
        with self.lock:
            self.queue.clear()
            self.last_leak = time.time()


class FixedWindowLimiter(RateLimiter):
    """
    Fixed Window Counter Algorithm
    
    Counts requests in fixed time windows.
    Simple but has boundary spike issues.
    
    Args:
        window_size: Window size in seconds
        limit: Maximum requests per window
    """
    
    def __init__(self, window_size: int, limit: int):
        self.window_size = window_size
        self.limit = limit
        self.window_start = 0
        self.count = 0
        self.lock = threading.Lock()
    
    def _current_window(self) -> int:
        """Get current window start time"""
        return int(time.time() // self.window_size) * self.window_size
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
            now = time.time()
            current_window = self._current_window()
            
            # Reset if in new window
            if current_window != self.window_start:
                self.window_start = current_window
                self.count = 0
            
            if self.count + tokens <= self.limit:
                self.count += tokens
                return RateLimitResult(
                    allowed=True,
                    limit=self.limit,
                    remaining=self.limit - self.count,
                    reset_at=self.window_start + self.window_size
                )
            else:
                return RateLimitResult(
                    allowed=False,
                    limit=self.limit,
                    remaining=0,
                    reset_at=self.window_start + self.window_size,
                    retry_after=self.window_start + self.window_size - now
                )
    
    def reset(self):
        with self.lock:
            self.window_start = self._current_window()
            self.count = 0


class SlidingWindowLogLimiter(RateLimiter):
    """
    Sliding Window Log Algorithm
    
    Maintains a log of all request timestamps.
    Most accurate but memory intensive.
    
    Args:
        window_size: Window size in seconds
        limit: Maximum requests per window
    """
    
    def __init__(self, window_size: int, limit: int):
        self.window_size = window_size
        self.limit = limit
        self.requests = deque()
        self.lock = threading.Lock()
    
    def _remove_old_requests(self, now: float):
        """Remove requests outside the current window"""
        cutoff = now - self.window_size
        while self.requests and self.requests[0] <= cutoff:
            self.requests.popleft()
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
            now = time.time()
            self._remove_old_requests(now)
            
            if len(self.requests) + tokens <= self.limit:
                for _ in range(tokens):
                    self.requests.append(now)
                
                return RateLimitResult(
                    allowed=True,
                    limit=self.limit,
                    remaining=self.limit - len(self.requests),
                    reset_at=self.requests[0] + self.window_size if self.requests else now + self.window_size
                )
            else:
                # Calculate when oldest request will expire
                retry_after = (self.requests[0] + self.window_size) - now if self.requests else 0
                
                return RateLimitResult(
                    allowed=False,
                    limit=self.limit,
                    remaining=0,
                    reset_at=self.requests[0] + self.window_size if self.requests else now,
                    retry_after=max(0, retry_after)
                )
    
    def reset(self):
        with self.lock:
            self.requests.clear()


class SlidingWindowCounterLimiter(RateLimiter):
    """
    Sliding Window Counter Algorithm
    
    Hybrid approach using two fixed windows.
    Good balance of accuracy and efficiency.
    
    Args:
        window_size: Window size in seconds
        limit: Maximum requests per window
    """
    
    def __init__(self, window_size: int, limit: int):
        self.window_size = window_size
        self.limit = limit
        self.current_window = {'start': 0, 'count': 0}
        self.previous_window = {'start': 0, 'count': 0}
        self.lock = threading.Lock()
    
    def _estimate_count(self, now: float) -> float:
        """Calculate estimated count using sliding window"""
        elapsed = now - self.current_window['start']
        overlap_pct = max(0, (self.window_size - elapsed) / self.window_size)
        
        return (self.previous_window['count'] * overlap_pct + 
                self.current_window['count'])
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
            now = time.time()
            window_start = int(now // self.window_size) * self.window_size
            
            # Move to new window if needed
            if window_start != self.current_window['start']:
                self.previous_window = self.current_window.copy()
                self.current_window = {'start': window_start, 'count': 0}
            
            estimated_count = self._estimate_count(now)
            
            if estimated_count + tokens <= self.limit:
                self.current_window['count'] += tokens
                
                return RateLimitResult(
                    allowed=True,
                    limit=self.limit,
                    remaining=max(0, int(self.limit - estimated_count - tokens)),
                    reset_at=self.current_window['start'] + self.window_size
                )
            else:
                return RateLimitResult(
                    allowed=False,
                    limit=self.limit,
                    remaining=0,
                    reset_at=self.current_window['start'] + self.window_size,
                    retry_after=self.current_window['start'] + self.window_size - now
                )
    
    def reset(self):
        with self.lock:
            now = time.time()
            window_start = int(now // self.window_size) * self.window_size
            self.current_window = {'start': window_start, 'count': 0}
            self.previous_window = {'start': 0, 'count': 0}


class ConcurrentRequestsLimiter(RateLimiter):
    """
    Concurrent Requests Limiter
    
    Limits the number of simultaneous active requests.
    
    Args:
        max_concurrent: Maximum concurrent requests
    """
    
    def __init__(self, max_concurrent: int):
        self.max_concurrent = max_concurrent
        self.active_requests = 0
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        with self.lock:
            if self.active_requests + tokens <= self.max_concurrent:
                self.active_requests += tokens
                return RateLimitResult(
                    allowed=True,
                    limit=self.max_concurrent,
                    remaining=self.max_concurrent - self.active_requests,
                    reset_at=0  # N/A for concurrent limiter
                )
            else:
                return RateLimitResult(
                    allowed=False,
                    limit=self.max_concurrent,
                    remaining=0,
                    reset_at=0,
                    retry_after=None  # Unknown
                )
    
    def release(self, tokens: int = 1):
        """Release tokens when request completes"""
        with self.lock:
            self.active_requests = max(0, self.active_requests - tokens)
            self.condition.notify_all()
    
    def reset(self):
        with self.lock:
            self.active_requests = 0


class MultiTierLimiter:
    """
    Multi-tier rate limiter with multiple limits
    
    Example: 10 req/sec AND 1000 req/hour
    """
    
    def __init__(self, limiters: List[RateLimiter]):
        self.limiters = limiters
    
    def allow_request(self, tokens: int = 1) -> RateLimitResult:
        """Check all limiters - all must pass"""
        results = []
        
        for limiter in self.limiters:
            result = limiter.allow_request(tokens)
            results.append(result)
            
            if not result.allowed:
                # Rollback successful limiters
                for prev_limiter in self.limiters[:len(results)-1]:
                    if hasattr(prev_limiter, 'rollback'):
                        prev_limiter.rollback(tokens)
                
                return result
        
        # Return most restrictive result
        return min(results, key=lambda r: r.remaining)


# Example usage and testing
if __name__ == "__main__":
    print("Rate Limiting Library - Python Implementation")
    print("=" * 50)
    
    # Token Bucket Example
    print("\n1. Token Bucket (capacity=10, rate=2/sec)")
    tb = TokenBucketLimiter(capacity=10, refill_rate=2)
    
    for i in range(12):
        result = tb.allow_request()
        print(f"Request {i+1}: {'✓' if result.allowed else '✗'} "
              f"(remaining: {result.remaining})")
    
    # Fixed Window Example
    print("\n2. Fixed Window (60s window, 5 req limit)")
    fw = FixedWindowLimiter(window_size=60, limit=5)
    
    for i in range(7):
        result = fw.allow_request()
        print(f"Request {i+1}: {'✓' if result.allowed else '✗'} "
              f"(remaining: {result.remaining})")
    
    # Sliding Window Counter Example
    print("\n3. Sliding Window Counter (60s window, 10 req limit)")
    swc = SlidingWindowCounterLimiter(window_size=60, limit=10)
    
    for i in range(12):
        result = swc.allow_request()
        print(f"Request {i+1}: {'✓' if result.allowed else '✗'} "
              f"(remaining: {result.remaining})")
