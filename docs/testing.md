# Testing Rate Limiters

## Unit Testing

### Basic Tests

```typescript
import { SlidingWindowCounterLimiter } from './rate-limiter';

describe('SlidingWindowCounterLimiter', () => {
  test('should allow requests up to limit', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 10);
    
    for (let i = 0; i < 10; i++) {
      const result = limiter.allowRequest();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - i - 1);
    }
  });

  test('should reject requests over limit', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 10);
    
    // Use up limit
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest();
    }
    
    // Should reject
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test('should reset after window expires', async () => {
    const limiter = new SlidingWindowCounterLimiter(1, 5);
    
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

  test('should handle concurrent requests', async () => {
    const limiter = new SlidingWindowCounterLimiter(60, 100);
    
    const promises = Array(100).fill(null).map(() => 
      Promise.resolve(limiter.allowRequest())
    );
    
    const results = await Promise.all(promises);
    const allowed = results.filter(r => r.allowed).length;
    
    expect(allowed).toBe(100);
  });
});
```

### Edge Cases

```typescript
describe('Edge Cases', () => {
  test('should handle zero limit', () => {
    const limiter = new TokenBucketLimiter(0, 1);
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(false);
  });

  test('should handle very small windows', async () => {
    const limiter = new FixedWindowLimiter(0.1, 5);
    
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest();
    }
    
    await sleep(150);
    
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
  });

  test('should handle fractional tokens', () => {
    const limiter = new TokenBucketLimiter(10, 0.5);
    
    // Should refill 0.5 tokens per second
    const initial = limiter.allowRequest();
    expect(initial.allowed).toBe(true);
  });
});
```

## Integration Testing

### Express Middleware Testing

```typescript
import request from 'supertest';
import express from 'express';
import { rateLimit } from './express-middleware';

describe('Rate Limit Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(rateLimit({
      windowSize: 60,
      limit: 10
    }));
    
    app.get('/test', (req, res) => {
      res.json({ success: true });
    });
  });

  test('should allow requests within limit', async () => {
    for (let i = 0; i < 10; i++) {
      const response = await request(app).get('/test');
      expect(response.status).toBe(200);
    }
  });

  test('should return 429 when limit exceeded', async () => {
    // Make 10 requests
    for (let i = 0; i < 10; i++) {
      await request(app).get('/test');
    }
    
    // 11th should be rate limited
    const response = await request(app).get('/test');
    expect(response.status).toBe(429);
    expect(response.body.error).toBe('Too Many Requests');
  });

  test('should include rate limit headers', async () => {
    const response = await request(app).get('/test');
    
    expect(response.headers['x-ratelimit-limit']).toBe('10');
    expect(response.headers['x-ratelimit-remaining']).toBeDefined();
    expect(response.headers['x-ratelimit-reset']).toBeDefined();
  });

  test('should include retry-after header when limited', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).get('/test');
    }
    
    const response = await request(app).get('/test');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
```

### Distributed Testing

```typescript
import { createClient } from 'redis';
import { RedisSlidingWindowCounter } from './redis-adapter';

describe('Distributed Rate Limiting', () => {
  let redis: RedisClient;
  
  beforeAll(async () => {
    redis = createClient();
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushDb();
  });

  test('should limit across multiple instances', async () => {
    const limiter1 = new RedisSlidingWindowCounter(redis, 'test', 60, 100);
    const limiter2 = new RedisSlidingWindowCounter(redis, 'test', 60, 100);
    const limiter3 = new RedisSlidingWindowCounter(redis, 'test', 60, 100);

    // Each instance makes requests
    const results1 = await Promise.all(
      Array(40).fill(null).map(() => limiter1.consume())
    );
    const results2 = await Promise.all(
      Array(40).fill(null).map(() => limiter2.consume())
    );
    const results3 = await Promise.all(
      Array(40).fill(null).map(() => limiter3.consume())
    );

    const totalAllowed = [results1, results2, results3]
      .flat()
      .filter(r => r.allowed).length;

    // Should allow exactly 100
    expect(totalAllowed).toBe(100);
  });
});
```

## Load Testing

### Artillery Configuration

```yaml
# artillery-config.yml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 100
      name: "Sustained load"
    - duration: 30
      arrivalRate: 500
      name: "Spike"

scenarios:
  - name: "API requests"
    flow:
      - get:
          url: "/api/data"
          headers:
            Authorization: "Bearer test-token"
```

Run:
```bash
artillery run artillery-config.yml
```

### k6 Load Testing

```javascript
// k6-script.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500'],
    'rate_limit_hits': ['rate<0.1'], // Less than 10% rate limited
  },
};

export default function () {
  let response = http.get('http://localhost:3000/api/data');
  
  check(response, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  });

  if (response.status === 429) {
    metrics.rateLimitHits.add(1);
  }

  sleep(1);
}
```

Run:
```bash
k6 run k6-script.js
```

## Performance Testing

### Benchmark Suite

```typescript
import Benchmark from 'benchmark';

const suite = new Benchmark.Suite();

suite
  .add('TokenBucket', () => {
    const limiter = new TokenBucketLimiter(1000, 100);
    limiter.allowRequest();
  })
  .add('FixedWindow', () => {
    const limiter = new FixedWindowLimiter(60, 1000);
    limiter.allowRequest();
  })
  .add('SlidingWindowCounter', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 1000);
    limiter.allowRequest();
  })
  .add('SlidingWindowLog', () => {
    const limiter = new SlidingWindowLogLimiter(60, 1000);
    limiter.allowRequest();
  })
  .on('cycle', (event: any) => {
    console.log(String(event.target));
  })
  .on('complete', function(this: any) {
    console.log('Fastest is ' + this.filter('fastest').map('name'));
  })
  .run({ async: true });
```

### Memory Profiling

```typescript
import v8 from 'v8';
import { writeFileSync } from 'fs';

function profileMemory(name: string, fn: () => void) {
  // Force garbage collection
  if (global.gc) global.gc();
  
  const before = process.memoryUsage();
  
  fn();
  
  if (global.gc) global.gc();
  const after = process.memoryUsage();
  
  console.log(`${name} Memory Usage:`);
  console.log(`  Heap Used: ${(after.heapUsed - before.heapUsed) / 1024 / 1024} MB`);
  
  // Take heap snapshot
  const snapshot = v8.writeHeapSnapshot(`./snapshots/${name}.heapsnapshot`);
  console.log(`  Snapshot: ${snapshot}`);
}

// Profile different limiters
profileMemory('TokenBucket', () => {
  const limiter = new TokenBucketLimiter(10000, 1000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});
```

## Chaos Testing

### Network Failures

```typescript
describe('Chaos Testing', () => {
  test('should handle Redis disconnection', async () => {
    const limiter = new ResilientRateLimiter();
    
    // Simulate Redis failure
    await redis.quit();
    
    // Should fall back to in-memory limiter
    const result = await limiter.allowRequest('user1');
    expect(result.allowed).toBeDefined();
  });

  test('should handle slow Redis responses', async () => {
    // Add latency
    const slowRedis = new Proxy(redis, {
      get(target, prop) {
        const original = target[prop];
        if (typeof original === 'function') {
          return async (...args: any[]) => {
            await sleep(1000); // Add 1s delay
            return original.apply(target, args);
          };
        }
        return original;
      }
    });

    const limiter = new RedisSlidingWindowCounter(slowRedis, 'test', 60, 100);
    
    const start = Date.now();
    await limiter.consume();
    const duration = Date.now() - start;
    
    // Should timeout or use fallback
    expect(duration).toBeLessThan(2000);
  });
});
```

## Test Coverage

### Run Coverage

```bash
npm run test:coverage
```

### Target Coverage

- **Lines**: 90%+
- **Branches**: 85%+
- **Functions**: 90%+
- **Statements**: 90%+

### Coverage Report

```typescript
// jest.config.js
module.exports = {
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90
    }
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/examples/**'
  ]
};
```

## Continuous Testing

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      redis:
        image: redis:latest
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v2
      
      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
        env:
          REDIS_URL: redis://localhost:6379
      
      - name: Upload coverage
        uses: codecov/codecov-action@v2
```

## Best Testing Practices

1. **Test All Algorithms**: Ensure each algorithm works correctly
2. **Test Edge Cases**: Zero limits, very small windows, fractional values
3. **Test Concurrency**: Verify thread-safety
4. **Test Distribution**: Ensure multi-instance correctness
5. **Test Failures**: Verify graceful degradation
6. **Test Performance**: Benchmark under realistic load
7. **Test in Production**: Monitor real-world behavior
8. **Continuous Testing**: Automate all tests in CI/CD
