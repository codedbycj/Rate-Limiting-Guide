# Getting Started with Rate Limiting - TypeScript

This guide will help you implement rate limiting in your TypeScript/JavaScript applications.

## Installation

```bash
# Clone the repository
git clone https://github.com/muditkalra/Rate-Limiting-Guide.git
cd rate-limiting-guide/implementations/typescript

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## Quick Start

### 1. Basic Express Middleware

```typescript
import express from 'express';
import { rateLimit } from './express-middleware';

const app = express();

// Apply rate limiting: 100 requests per minute
app.use('/api', rateLimit({
  windowSize: 60,      // 60 seconds
  limit: 100,          // 100 requests max
}));

app.get('/api/data', (req, res) => {
  res.json({ message: 'Success' });
});

app.listen(3000);
```

### 2. Direct Algorithm Usage

```typescript
import { SlidingWindowCounterLimiter } from './rate-limiter';

const limiter = new SlidingWindowCounterLimiter(60, 100);

function handleRequest() {
  const result = limiter.allowRequest();
  
  if (!result.allowed) {
    console.log(`Rate limited! Retry after ${result.retryAfter}s`);
    return;
  }
  
  console.log(`Request allowed. ${result.remaining} remaining`);
  // Process request...
}
```

## Core Concepts

### Rate Limit Result

All limiters return a `RateLimitResult` object:

```typescript
interface RateLimitResult {
  allowed: boolean;      // Whether request is allowed
  limit: number;         // Total limit
  remaining: number;     // Requests remaining
  resetAt: number;       // When limit resets (timestamp)
  retryAfter?: number;   // Seconds to wait (if rejected)
}
```

### Key Generator

Determines how to identify users:

```typescript
// By IP address (default)
keyGenerator: (req) => req.ip

// By user ID
keyGenerator: (req) => req.user?.id

// By API key
keyGenerator: (req) => req.headers['x-api-key']

// Combined
keyGenerator: (req) => `${req.user?.id}:${req.path}`
```

## Common Use Cases

### API Rate Limiting

```typescript
import { rateLimit } from './express-middleware';

// Public API: 1000 requests per hour
app.use('/api/public', rateLimit({
  windowSize: 3600,
  limit: 1000
}));

// Authenticated API: 5000 requests per hour
app.use('/api/auth', rateLimit({
  windowSize: 3600,
  limit: 5000,
  keyGenerator: (req) => req.user?.id || req.ip
}));
```

### Login Protection

```typescript
// Only 5 login attempts per 15 minutes
app.post('/login', rateLimit({
  windowSize: 900,    // 15 minutes
  limit: 5,
  keyGenerator: (req) => req.body.email || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many login attempts',
      message: 'Please try again in 15 minutes'
    });
  }
}));
```

### File Upload Limiting

```typescript
// Limit large file uploads
app.post('/upload', rateLimit({
  windowSize: 3600,
  limit: 10,          // 10 uploads per hour
  keyGenerator: (req) => req.user?.id
}));
```

### Different Limits Per Endpoint

```typescript
import { RateLimitFactory } from './express-middleware';

const factory = new RateLimitFactory();

app.get('/api/read', factory.permissive(60, 1000), handler);
app.post('/api/write', factory.standard(60, 100), handler);
app.delete('/api/delete', factory.strict(60, 10), handler);
```

## Choosing an Algorithm

### Sliding Window Counter (Recommended) ⭐

Best for most production use cases:

```typescript
import { SlidingWindowCounterLimiter } from './rate-limiter';

const limiter = new SlidingWindowCounterLimiter(
  60,    // window size (seconds)
  100    // max requests
);
```

**Pros**: Accurate, efficient, minimal boundary issues
**Cons**: Slightly approximate (98-99% accurate)

### Token Bucket

Best when you want to allow bursts:

```typescript
import { TokenBucketLimiter } from './rate-limiter';

const limiter = new TokenBucketLimiter(
  100,   // capacity (burst size)
  10     // refill rate (tokens/second)
);
```

**Pros**: Allows bursts, smooth average rate
**Cons**: Can allow sudden spikes

### Fixed Window

Best for simplicity:

```typescript
import { FixedWindowLimiter } from './rate-limiter';

const limiter = new FixedWindowLimiter(
  60,    // window size
  100    // limit
);
```

**Pros**: Very simple, minimal resources
**Cons**: Boundary issues (can allow 2x at boundaries)

### Sliding Window Log

Best for perfect accuracy:

```typescript
import { SlidingWindowLogLimiter } from './rate-limiter';

const limiter = new SlidingWindowLogLimiter(
  60,    // window size
  100    // limit
);
```

**Pros**: 100% accurate
**Cons**: Higher memory usage

### Concurrent Requests

Best for limiting simultaneous connections:

```typescript
import { ConcurrentRequestsLimiter } from './rate-limiter';

const limiter = new ConcurrentRequestsLimiter(10);

const result = limiter.allowRequest();
if (result.allowed) {
  try {
    // Process request
  } finally {
    limiter.release(); // Important!
  }
}
```

## Multi-Tier Rate Limiting

Apply multiple limits simultaneously:

```typescript
import { multiTierRateLimit } from './express-middleware';

app.use('/api', multiTierRateLimit([
  { windowSize: 1, limit: 10 },       // 10/second
  { windowSize: 60, limit: 100 },     // 100/minute
  { windowSize: 3600, limit: 1000 }   // 1000/hour
]));
```

## Distributed Rate Limiting with Redis

For multiple servers:

```typescript
import { RedisRateLimiterFactory } from './redis-adapter';

// Create Redis-backed factory
const factory = await RedisRateLimiterFactory.create({
  host: 'localhost',
  port: 6379
});

// Use sliding window counter
app.use('/api', async (req, res, next) => {
  const limiter = factory.slidingWindow(
    req.ip,    // identifier
    60,        // window size
    100        // limit
  );

  const result = await limiter.consume();

  if (!result.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
});
```

## Best Practices

### 1. Set Appropriate Headers

```typescript
app.use('/api', rateLimit({
  windowSize: 60,
  limit: 100,
  standardHeaders: true  // Include RateLimit-* headers
}));
```

Response headers:
```
RateLimit-Limit: 100
RateLimit-Remaining: 73
RateLimit-Reset: 1640000000
Retry-After: 45  (if rate limited)
```

### 2. Different Limits for Different Users

```typescript
app.use('/api', (req, res, next) => {
  const tier = req.user?.tier || 'free';
  
  const limits = {
    free: { windowSize: 60, limit: 10 },
    premium: { windowSize: 60, limit: 100 },
    enterprise: { windowSize: 60, limit: 1000 }
  };

  rateLimit({
    ...limits[tier],
    keyGenerator: (req) => req.user?.id || req.ip
  })(req, res, next);
});
```

### 3. Skip Rate Limiting for Certain Conditions

```typescript
app.use('/api', rateLimit({
  windowSize: 60,
  limit: 100,
  skip: (req) => {
    // Skip for admins
    if (req.user?.role === 'admin') return true;
    
    // Skip for whitelisted IPs
    const whitelist = ['127.0.0.1'];
    if (whitelist.includes(req.ip)) return true;
    
    return false;
  }
}));
```

### 4. Custom Error Messages

```typescript
app.use('/api', rateLimit({
  windowSize: 60,
  limit: 100,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate Limit Exceeded',
      message: 'You have exceeded the rate limit',
      limit: 100,
      window: '1 minute',
      retryAfter: res.getHeader('Retry-After')
    });
  }
}));
```

### 5. Monitor Rate Limit Violations

```typescript
app.use('/api', rateLimit({
  windowSize: 60,
  limit: 100,
  onLimit: (req, res, result) => {
    // Log to monitoring service
    console.warn(`Rate limit exceeded: ${req.ip}`);
    
    // Track metrics
    metrics.increment('rate_limit.exceeded', {
      endpoint: req.path,
      user: req.user?.id
    });
  }
}));
```

### 6. Cost-Based Rate Limiting

Different endpoints consume different amounts:

```typescript
const limiter = new TokenBucketLimiter(1000, 100);

app.get('/api/cheap', (req, res) => {
  const result = limiter.allowRequest(1);  // Costs 1 token
  if (!result.allowed) {
    return res.status(429).json({ error: 'Rate limited' });
  }
  res.json({ data: 'cheap operation' });
});

app.post('/api/expensive', (req, res) => {
  const result = limiter.allowRequest(10);  // Costs 10 tokens
  if (!result.allowed) {
    return res.status(429).json({ error: 'Rate limited' });
  }
  res.json({ data: 'expensive operation' });
});
```

## Testing

### Unit Tests

```typescript
import { SlidingWindowCounterLimiter } from './rate-limiter';

test('should allow requests up to limit', () => {
  const limiter = new SlidingWindowCounterLimiter(60, 10);
  
  for (let i = 0; i < 10; i++) {
    const result = limiter.allowRequest();
    expect(result.allowed).toBe(true);
  }
  
  // 11th request should fail
  const result = limiter.allowRequest();
  expect(result.allowed).toBe(false);
});
```

### Integration Tests

```typescript
import request from 'supertest';
import app from './app';

test('should rate limit after 100 requests', async () => {
  // Make 100 requests
  for (let i = 0; i < 100; i++) {
    await request(app).get('/api/data').expect(200);
  }
  
  // 101st should be rate limited
  const response = await request(app).get('/api/data');
  expect(response.status).toBe(429);
  expect(response.body.error).toBe('Too Many Requests');
});
```

## Troubleshooting

### Rate Limiter Not Working

1. Check key generator is unique per user
2. Verify middleware is applied before routes
3. Ensure time is synchronized (for distributed systems)

### Memory Issues

1. Use Sliding Window Counter instead of Sliding Window Log
2. Implement TTL for stored data
3. Use Redis for distributed systems

### Boundary Spike Issues

1. Switch from Fixed Window to Sliding Window Counter
2. Implement multi-tier limiting
3. Add buffer to limits (10% extra)

## Next Steps

1. Read [Algorithm Comparison](./algorithm-comparison.md)
2. Check [Examples](../implementations/typescript/examples.ts)
3. Review [Best Practices](./best-practices.md)
4. Explore [Distributed Rate Limiting](./distributed.md)

## Resources

- [Main README](../README.md)
- [TypeScript Implementation](../implementations/typescript/)
- [Test Suite](../implementations/typescript/rate-limiter.test.ts)
- [Express Middleware](../implementations/typescript/express-middleware.ts)
