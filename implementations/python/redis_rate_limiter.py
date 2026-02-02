"""
Distributed Rate Limiting using Redis

Implements rate limiting algorithms that work across multiple application instances.
Uses Redis for shared state and Lua scripts for atomic operations.
"""

import time
import redis
from typing import Optional, Dict
from dataclasses import dataclass


@dataclass
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_at: float
    retry_after: Optional[float] = None


class RedisRateLimiter:
    """Base class for Redis-based rate limiters"""
    
    def __init__(self, redis_client: redis.Redis, key_prefix: str = "rate_limit"):
        self.redis = redis_client
        self.key_prefix = key_prefix
    
    def _make_key(self, identifier: str, suffix: str = "") -> str:
        """Create Redis key for identifier"""
        key = f"{self.key_prefix}:{identifier}"
        if suffix:
            key = f"{key}:{suffix}"
        return key


class RedisTokenBucket(RedisRateLimiter):
    """
    Token Bucket implementation using Redis
    
    Uses Lua script for atomic operations.
    """
    
    # Lua script for atomic token bucket operations
    TOKEN_BUCKET_SCRIPT = """
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
    redis.call('EXPIRE', key, 3600)  -- 1 hour expiry
    
    -- Calculate retry_after if rejected
    local retry_after = 0
    if allowed == 0 then
        local tokens_needed = tokens_requested - tokens
        retry_after = tokens_needed / refill_rate
    end
    
    return {allowed, math.floor(tokens), retry_after}
    """
    
    def __init__(self, redis_client: redis.Redis, capacity: int, refill_rate: float):
        super().__init__(redis_client)
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.script = self.redis.register_script(self.TOKEN_BUCKET_SCRIPT)
    
    def allow_request(self, identifier: str, tokens: int = 1) -> RateLimitResult:
        """Check if request is allowed for identifier"""
        key = self._make_key(identifier)
        now = time.time()
        
        result = self.script(
            keys=[key],
            args=[self.capacity, self.refill_rate, tokens, now]
        )
        
        allowed, remaining, retry_after = result
        
        return RateLimitResult(
            allowed=bool(allowed),
            limit=self.capacity,
            remaining=int(remaining),
            reset_at=now + (self.capacity - remaining) / self.refill_rate if remaining < self.capacity else now,
            retry_after=float(retry_after) if retry_after > 0 else None
        )


class RedisFixedWindow(RedisRateLimiter):
    """
    Fixed Window Counter using Redis
    
    Simple and efficient implementation.
    """
    
    def __init__(self, redis_client: redis.Redis, window_size: int, limit: int):
        super().__init__(redis_client)
        self.window_size = window_size
        self.limit = limit
    
    def allow_request(self, identifier: str, tokens: int = 1) -> RateLimitResult:
        """Check if request is allowed"""
        now = time.time()
        window_start = int(now // self.window_size) * self.window_size
        key = self._make_key(identifier, str(window_start))
        
        pipe = self.redis.pipeline()
        pipe.get(key)
        pipe.expire(key, self.window_size * 2)
        current_count = pipe.execute()[0]
        
        current_count = int(current_count) if current_count else 0
        
        if current_count + tokens <= self.limit:
            self.redis.incrby(key, tokens)
            
            return RateLimitResult(
                allowed=True,
                limit=self.limit,
                remaining=self.limit - current_count - tokens,
                reset_at=window_start + self.window_size
            )
        else:
            return RateLimitResult(
                allowed=False,
                limit=self.limit,
                remaining=0,
                reset_at=window_start + self.window_size,
                retry_after=window_start + self.window_size - now
            )


class RedisSlidingWindowCounter(RedisRateLimiter):
    """
    Sliding Window Counter using Redis
    
    Most practical for production use.
    """
    
    SLIDING_WINDOW_SCRIPT = """
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
        -- Increment and set expiry
        redis.call('INCRBY', current_key, tokens)
        redis.call('EXPIRE', current_key, window_size * 2)
        allowed = 1
        remaining = limit - estimated_count - tokens
    else
        remaining = 0
    end
    
    return {allowed, remaining, estimated_count}
    """
    
    def __init__(self, redis_client: redis.Redis, window_size: int, limit: int):
        super().__init__(redis_client)
        self.window_size = window_size
        self.limit = limit
        self.script = self.redis.register_script(self.SLIDING_WINDOW_SCRIPT)
    
    def allow_request(self, identifier: str, tokens: int = 1) -> RateLimitResult:
        """Check if request is allowed"""
        now = time.time()
        window_start = int(now // self.window_size) * self.window_size
        prev_window_start = window_start - self.window_size
        
        current_key = self._make_key(identifier, str(window_start))
        previous_key = self._make_key(identifier, str(prev_window_start))
        
        result = self.script(
            keys=[current_key, previous_key],
            args=[self.window_size, self.limit, tokens, now, window_start]
        )
        
        allowed, remaining, estimated_count = result
        
        return RateLimitResult(
            allowed=bool(allowed),
            limit=self.limit,
            remaining=max(0, int(remaining)),
            reset_at=window_start + self.window_size,
            retry_after=window_start + self.window_size - now if not allowed else None
        )


class RedisSlidingWindowLog(RedisRateLimiter):
    """
    Sliding Window Log using Redis Sorted Set
    
    Most accurate but memory intensive.
    """
    
    def __init__(self, redis_client: redis.Redis, window_size: int, limit: int):
        super().__init__(redis_client)
        self.window_size = window_size
        self.limit = limit
    
    def allow_request(self, identifier: str, tokens: int = 1) -> RateLimitResult:
        """Check if request is allowed"""
        now = time.time()
        key = self._make_key(identifier)
        cutoff = now - self.window_size
        
        pipe = self.redis.pipeline()
        
        # Remove old entries
        pipe.zremrangebyscore(key, 0, cutoff)
        
        # Count current entries
        pipe.zcard(key)
        
        results = pipe.execute()
        current_count = results[1]
        
        if current_count + tokens <= self.limit:
            # Add new entries
            pipe = self.redis.pipeline()
            for i in range(tokens):
                pipe.zadd(key, {f"{now}:{i}": now})
            pipe.expire(key, self.window_size)
            pipe.execute()
            
            return RateLimitResult(
                allowed=True,
                limit=self.limit,
                remaining=self.limit - current_count - tokens,
                reset_at=now + self.window_size
            )
        else:
            # Get oldest entry to calculate retry_after
            oldest = self.redis.zrange(key, 0, 0, withscores=True)
            retry_after = (oldest[0][1] + self.window_size - now) if oldest else 0
            
            return RateLimitResult(
                allowed=False,
                limit=self.limit,
                remaining=0,
                reset_at=now + retry_after,
                retry_after=max(0, retry_after)
            )


class RedisRateLimiterFactory:
    """Factory for creating Redis-based rate limiters"""
    
    @staticmethod
    def create_token_bucket(
        redis_url: str,
        capacity: int,
        refill_rate: float
    ) -> RedisTokenBucket:
        client = redis.from_url(redis_url)
        return RedisTokenBucket(client, capacity, refill_rate)
    
    @staticmethod
    def create_fixed_window(
        redis_url: str,
        window_size: int,
        limit: int
    ) -> RedisFixedWindow:
        client = redis.from_url(redis_url)
        return RedisFixedWindow(client, window_size, limit)
    
    @staticmethod
    def create_sliding_window_counter(
        redis_url: str,
        window_size: int,
        limit: int
    ) -> RedisSlidingWindowCounter:
        client = redis.from_url(redis_url)
        return RedisSlidingWindowCounter(client, window_size, limit)
    
    @staticmethod
    def create_sliding_window_log(
        redis_url: str,
        window_size: int,
        limit: int
    ) -> RedisSlidingWindowLog:
        client = redis.from_url(redis_url)
        return RedisSlidingWindowLog(client, window_size, limit)


# Decorator for easy rate limiting
def rate_limit(
    limiter: RedisRateLimiter,
    get_identifier=lambda: "default"
):
    """
    Decorator to rate limit function calls
    
    Usage:
        @rate_limit(limiter, get_identifier=lambda: request.user.id)
        def api_endpoint():
            ...
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            identifier = get_identifier()
            result = limiter.allow_request(identifier)
            
            if not result.allowed:
                raise RateLimitExceeded(
                    f"Rate limit exceeded. Retry after {result.retry_after}s",
                    result
                )
            
            return func(*args, **kwargs)
        return wrapper
    return decorator


class RateLimitExceeded(Exception):
    """Exception raised when rate limit is exceeded"""
    
    def __init__(self, message: str, result: RateLimitResult):
        super().__init__(message)
        self.result = result


# Example usage
if __name__ == "__main__":
    # Connect to Redis
    redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)
    
    print("Redis-based Rate Limiting Examples")
    print("=" * 50)
    
    # Example 1: Token Bucket
    print("\n1. Token Bucket (capacity=10, rate=2/sec)")
    tb = RedisTokenBucket(redis_client, capacity=10, refill_rate=2)
    
    for i in range(12):
        result = tb.allow_request("user:123")
        print(f"Request {i+1}: {'✓' if result.allowed else '✗'} "
              f"(remaining: {result.remaining})")
    
    # Example 2: Sliding Window Counter
    print("\n2. Sliding Window Counter (60s window, 10 req)")
    swc = RedisSlidingWindowCounter(redis_client, window_size=60, limit=10)
    
    for i in range(12):
        result = swc.allow_request("user:456")
        print(f"Request {i+1}: {'✓' if result.allowed else '✗'} "
              f"(remaining: {result.remaining})")
    
    # Example 3: Multiple identifiers
    print("\n3. Multiple Users")
    fw = RedisFixedWindow(redis_client, window_size=60, limit=5)
    
    users = ["alice", "bob", "charlie"]
    for user in users:
        result = fw.allow_request(f"user:{user}")
        print(f"User {user}: {'✓' if result.allowed else '✗'}")
