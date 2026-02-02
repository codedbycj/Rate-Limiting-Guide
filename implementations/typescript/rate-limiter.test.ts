/**
 * Rate Limiter Test Suite - TypeScript
 * 
 * Comprehensive tests for all rate limiting algorithms
 */

import {
  TokenBucketLimiter,
  LeakyBucketLimiter,
  FixedWindowLimiter,
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  ConcurrentRequestsLimiter,
  MultiTierLimiter
} from './rate-limiter';

/**
 * Utility function to sleep
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Test helper for running multiple requests
 */
async function runRequests(
  limiter: any,
  count: number,
  delay: number = 0
): Promise<boolean[]> {
  const results: boolean[] = [];
  
  for (let i = 0; i < count; i++) {
    if (delay > 0 && i > 0) {
      await sleep(delay);
    }
    const result = await Promise.resolve(limiter.allowRequest());
    results.push(result.allowed);
  }
  
  return results;
}

/**
 * Token Bucket Tests
 */
describe('TokenBucketLimiter', () => {
  test('should allow requests up to capacity', () => {
    const limiter = new TokenBucketLimiter(10, 2);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    }
  });

  test('should reject requests over capacity', () => {
    const limiter = new TokenBucketLimiter(10, 2);
    
    // Consume all tokens
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Next request should fail
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test('should refill tokens over time', async () => {
    const limiter = new TokenBucketLimiter(10, 5); // 5 tokens per second
    
    // Consume all tokens
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Wait 1 second (should refill 5 tokens)
    await sleep(1000);
    
    // Should allow 5 requests
    for (let i = 0; i < 5; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
    
    // 6th should fail
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should not exceed capacity when refilling', async () => {
    const limiter = new TokenBucketLimiter(10, 5);
    
    // Wait 5 seconds (would add 25 tokens, but capped at 10)
    await sleep(5000);
    
    // Should only allow 10 requests
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should handle weighted requests', () => {
    const limiter = new TokenBucketLimiter(10, 2);
    
    // Consume 5 tokens
    const result1 = limiter.allowRequest(5);
    expect(result1.allowed).toBe(true);
    expect(result1.remaining).toBe(5);
    
    // Try to consume 6 tokens (should fail)
    const result2 = limiter.allowRequest(6);
    expect(result2.allowed).toBe(false);
    
    // Consume 5 more tokens (should succeed)
    const result3 = limiter.allowRequest(5);
    expect(result3.allowed).toBe(true);
    expect(result3.remaining).toBe(0);
  });

  test('should reset correctly', () => {
    const limiter = new TokenBucketLimiter(10, 2);
    
    // Consume all tokens
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Reset
    limiter.reset();
    
    // Should have full capacity again
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });
});

/**
 * Leaky Bucket Tests
 */
describe('LeakyBucketLimiter', () => {
  test('should allow requests up to capacity', () => {
    const limiter = new LeakyBucketLimiter(10, 2);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
  });

  test('should reject requests over capacity', () => {
    const limiter = new LeakyBucketLimiter(10, 2);
    
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should leak requests over time', async () => {
    const limiter = new LeakyBucketLimiter(10, 5); // 5 requests per second
    
    // Fill the bucket
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Wait 1 second (should leak 5 requests)
    await sleep(1000);
    
    // Should have space for 5 more
    for (let i = 0; i < 5; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
  });
});

/**
 * Fixed Window Tests
 */
describe('FixedWindowLimiter', () => {
  test('should allow requests up to limit', () => {
    const limiter = new FixedWindowLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - i - 1);
    }
  });

  test('should reject requests over limit', () => {
    const limiter = new FixedWindowLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('should reset at window boundary', async () => {
    const limiter = new FixedWindowLimiter(1, 5); // 1 second window
    
    // Fill the window
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    // Wait for new window
    await sleep(1100);
    
    // Should allow requests again
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });
});

/**
 * Sliding Window Log Tests
 */
describe('SlidingWindowLogLimiter', () => {
  test('should allow requests up to limit', () => {
    const limiter = new SlidingWindowLogLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
  });

  test('should reject requests over limit', () => {
    const limiter = new SlidingWindowLogLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should track requests in sliding window', async () => {
    const limiter = new SlidingWindowLogLimiter(2, 5); // 2 second window
    
    // Make 5 requests
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    // Wait 1 second
    await sleep(1000);
    
    // Still should reject (all requests still in window)
    let result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    
    // Wait another 1.5 seconds (total 2.5s, old requests expired)
    await sleep(1500);
    
    // Should allow new requests
    result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
  });

  test('should maintain accurate count', async () => {
    const limiter = new SlidingWindowLogLimiter(1, 10);
    
    // Make 3 requests
    for (let i = 0; i < 3; i++) {
      limiter.allowRequest();
    }
    
    expect(limiter.getRequestCount()).toBe(3);
    
    // Wait for window to expire
    await sleep(1100);
    
    expect(limiter.getRequestCount()).toBe(0);
  });
});

/**
 * Sliding Window Counter Tests
 */
describe('SlidingWindowCounterLimiter', () => {
  test('should allow requests up to limit', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
    }
  });

  test('should reject requests over limit', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should handle window transition', async () => {
    const limiter = new SlidingWindowCounterLimiter(1, 10);
    
    // Fill current window
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Wait half a second
    await sleep(500);
    
    // Should still be near limit (considering overlap)
    const result1 = limiter.allowRequest();
    expect(result1.allowed).toBe(false);
    
    // Wait for new window
    await sleep(600);
    
    // Should allow requests in new window
    const result2 = limiter.allowRequest();
    expect(result2.allowed).toBe(true);
  });
});

/**
 * Concurrent Requests Tests
 */
describe('ConcurrentRequestsLimiter', () => {
  test('should allow requests up to limit', () => {
    const limiter = new ConcurrentRequestsLimiter(5);
    
    for (let i = 0; i < 5; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i - 1);
    }
  });

  test('should reject when at limit', () => {
    const limiter = new ConcurrentRequestsLimiter(5);
    
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('should allow after release', () => {
    const limiter = new ConcurrentRequestsLimiter(5);
    
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    // Release 2
    limiter.release(2);
    
    // Should allow 2 more
    const result1 = limiter.allowRequest();
    expect(result1.allowed).toBe(true);
    
    const result2 = limiter.allowRequest();
    expect(result2.allowed).toBe(true);
    
    // 3rd should fail
    const result3 = limiter.allowRequest();
    expect(result3.allowed).toBe(false);
  });

  test('should track active count correctly', () => {
    const limiter = new ConcurrentRequestsLimiter(10);
    
    limiter.allowRequest(3);
    expect(limiter.getActiveCount()).toBe(3);
    
    limiter.allowRequest(2);
    expect(limiter.getActiveCount()).toBe(5);
    
    limiter.release(2);
    expect(limiter.getActiveCount()).toBe(3);
  });
});

/**
 * Multi-Tier Tests
 */
describe('MultiTierLimiter', () => {
  test('should enforce all limits', async () => {
    const limiter1 = new FixedWindowLimiter(1, 5);  // 5 per second
    const limiter2 = new FixedWindowLimiter(10, 20); // 20 per 10 seconds
    
    const multiTier = new MultiTierLimiter([limiter1, limiter2]);
    
    // Should allow 5 requests (limited by first tier)
    for (let i = 0; i < 5; i++) {
      const result = await multiTier.allowRequest();
      expect(result.allowed).toBe(true);
    }
    
    // 6th should fail
    const result = await multiTier.allowRequest();
    expect(result.allowed).toBe(false);
  });
});

/**
 * Performance Tests
 */
describe('Performance', () => {
  test('should handle high throughput', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 10000);
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      limiter.allowRequest();
    }
    
    const duration = Date.now() - start;
    console.log(`10,000 requests in ${duration}ms`);
    expect(duration).toBeLessThan(1000); // Should complete in under 1 second
  });

  test('should have O(1) time complexity', () => {
    const limiter = new TokenBucketLimiter(1000000, 100);
    
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = Date.now();
      limiter.allowRequest();
      times.push(Date.now() - start);
    }
    
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avgTime).toBeLessThan(1); // Should be sub-millisecond
  });
});

/**
 * Edge Cases
 */
describe('Edge Cases', () => {
  test('should handle zero capacity', () => {
    const limiter = new TokenBucketLimiter(0, 1);
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should handle very small windows', async () => {
    const limiter = new FixedWindowLimiter(0.1, 5); // 100ms window
    
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    await sleep(150);
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
  });

  test('should handle concurrent access', async () => {
    const limiter = new SlidingWindowCounterLimiter(60, 100);
    
    const promises = Array(100).fill(null).map(() => 
      Promise.resolve(limiter.allowRequest())
    );
    
    const results = await Promise.all(promises);
    const allowed = results.filter(r => r.allowed).length;
    
    expect(allowed).toBe(100);
  });
});

/**
 * Run all tests
 */
export function runTests() {
  console.log('Running Rate Limiter Tests...\n');
  
  // Note: In a real implementation, you would use a testing framework like Jest
  // This is a simplified version for demonstration
  
  console.log('✅ All tests would run here with a proper test runner');
}
