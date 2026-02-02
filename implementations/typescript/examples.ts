/**
 * Rate Limiter Usage Examples - TypeScript
 * 
 * Comprehensive examples showing how to use the rate limiting library
 */

import express, { NextFunction, Request, Response } from 'express';
import {
  TokenBucketLimiter,
  SlidingWindowCounterLimiter,
  FixedWindowLimiter,
  ConcurrentRequestsLimiter,
  MultiTierLimiter
} from './rate-limiter';
import { rateLimit, RateLimitFactory, multiTierRateLimit } from './express-middleware';
import { RedisRateLimiterFactory } from './redis-adapter';

// ============================================================================
// EXAMPLE 1: Basic In-Memory Rate Limiting
// ============================================================================

function basicExample() {
  const app = express();

  // Simple rate limiter: 100 requests per minute per IP
  app.use('/api', rateLimit({
    windowSize: 60,
    limit: 100,
    keyGenerator: (req) => req.ip || 'unknown'
  }));

  app.get('/api/data', (req: Request, res: Response) => {
    res.json({ message: 'Data retrieved successfully' });
  });

  app.listen(3000);
}

// ============================================================================
// EXAMPLE 2: Different Algorithms
// ============================================================================

function algorithmExamples() {
  const app = express();

  // Token Bucket - allows bursts
  app.use('/api/burst', rateLimit({
    algorithm: 'token-bucket',
    capacity: 100,
    refillRate: 10, // 10 tokens per second
    keyGenerator: (req) => req.ip || 'unknown'
  }));

  // Fixed Window - simple but has boundary issues
  app.use('/api/simple', rateLimit({
    algorithm: 'fixed-window',
    windowSize: 60,
    limit: 100
  }));

  // Sliding Window Counter - best for production
  app.use('/api/production', rateLimit({
    algorithm: 'sliding-window-counter',
    windowSize: 60,
    limit: 100
  }));

  // Sliding Window Log - most accurate
  app.use('/api/precise', rateLimit({
    algorithm: 'sliding-window-log',
    windowSize: 60,
    limit: 100
  }));

  // Concurrent Requests - limits simultaneous connections
  app.use('/api/concurrent', rateLimit({
    algorithm: 'concurrent',
    limit: 10 // Max 10 concurrent requests
  }));

  app.listen(3001);
}

// ============================================================================
// EXAMPLE 3: Multi-Tier Rate Limiting
// ============================================================================

function multiTierExample() {
  const app = express();

  // Apply multiple rate limits: 10/second AND 1000/hour
  app.use('/api/strict', multiTierRateLimit([
    { windowSize: 1, limit: 10 },      // 10 per second
    { windowSize: 60, limit: 100 },    // 100 per minute
    { windowSize: 3600, limit: 1000 }  // 1000 per hour
  ]));

  app.get('/api/strict/resource', (req, res) => {
    res.json({ message: 'Protected resource' });
  });

  app.listen(3002);
}

// ============================================================================
// EXAMPLE 4: Per-User Rate Limiting
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    tier: 'free' | 'premium' | 'enterprise';
  };
}

function perUserExample() {
  const app = express();

  // Middleware to add user to request (simplified)
  app.use((req: AuthenticatedRequest, res, next) => {
    // In real app, extract from JWT or session
    req.user = { id: 'user123', tier: 'premium' };
    next();
  });

  // Rate limit per user ID
  app.use('/api/user', rateLimit({
    windowSize: 60,
    limit: 100,
    keyGenerator: (req: AuthenticatedRequest) =>
      req.user?.id || req.ip || 'anonymous'
  }));

  app.get('/api/user/profile', (req: AuthenticatedRequest, res) => {
    res.json({ userId: req.user?.id });
  });

  app.listen(3003);
}

// ============================================================================
// EXAMPLE 5: Tiered Rate Limits by User Plan
// ============================================================================

function tieredRateLimits() {
  const app = express();

  app.use((req: AuthenticatedRequest, res, next) => {
    req.user = { id: 'user123', tier: 'premium' };
    next();
  });

  // Different limits based on user tier
  app.use('/api', (req: AuthenticatedRequest, res, next) => {
    const tier = req.user?.tier || 'free';

    const limits = {
      free: { windowSize: 60, limit: 10 },
      premium: { windowSize: 60, limit: 100 },
      enterprise: { windowSize: 60, limit: 1000 }
    };

    const limiter = rateLimit({
      ...limits[tier],
      keyGenerator: (req: AuthenticatedRequest) => req.user?.id || req.ip || 'unknown'
    });

    limiter(req, res, next);
  });

  app.get('/api/data', (req, res) => {
    res.json({ message: 'Data' });
  });

  app.listen(3004);
}

// ============================================================================
// EXAMPLE 6: Skip Conditions
// ============================================================================

function skipConditionsExample() {
  const app = express();

  // Skip rate limiting for premium users
  app.use('/api', rateLimit({
    windowSize: 60,
    limit: 100,
    skip: (req: AuthenticatedRequest) => req.user?.tier === 'enterprise',
    keyGenerator: (req) => (req as AuthenticatedRequest).user?.id || req.ip || 'unknown'
  }));

  // Skip rate limiting for specific IPs (whitelisted)
  const whitelist = ['127.0.0.1', '::1'];
  app.use('/api/admin', rateLimit({
    windowSize: 60,
    limit: 10,
    skip: (req) => whitelist.includes(req.ip || '')
  }));

  app.listen(3005);
}

// ============================================================================
// EXAMPLE 7: Custom Error Handlers
// ============================================================================

function customErrorHandlers() {
  const app = express();

  // Custom handler when rate limit is exceeded
  app.use('/api', rateLimit({
    windowSize: 60,
    limit: 100,
    handler: (req, res) => {
      res.status(429).json({
        error: 'Rate Limit Exceeded',
        message: 'You have made too many requests. Please slow down.',
        documentation: 'https://api.example.com/docs/rate-limits'
      });
    }
  }));

  // Custom onLimit callback (for logging/monitoring)
  app.use('/api/monitored', rateLimit({
    windowSize: 60,
    limit: 100,
    onLimit: (req, res, result) => {
      console.log(`Rate limit exceeded for ${req.ip}: ${result.remaining} remaining`);
      // Send to monitoring service
      // trackRateLimitViolation(req.ip, result);
    }
  }));

  app.listen(3006);
}

// ============================================================================
// EXAMPLE 8: Using Rate Limiter Factory
// ============================================================================

function factoryExample() {
  const app = express();

  const factory = new RateLimitFactory({
    algorithm: 'sliding-window-counter',
    windowSize: 60
  });

  // Different endpoints with different limits
  app.get('/api/public', factory.permissive(60, 1000), (req, res) => {
    res.json({ message: 'Public endpoint - high limit' });
  });

  app.post('/api/login', factory.strict(300, 5), (req, res) => {
    // Only 5 login attempts per 5 minutes
    res.json({ message: 'Login attempt' });
  });

  app.get('/api/data', factory.standard(60, 100), (req, res) => {
    res.json({ message: 'Standard endpoint' });
  });

  // Per-user limits
  app.get('/api/user-data',
    factory.perUser((req: AuthenticatedRequest) => req.user?.id || 'anonymous', 50),
    (req, res) => {
      res.json({ message: 'User data' });
    }
  );

  // Per-IP limits
  app.get('/api/public-data', factory.perIP(100), (req, res) => {
    res.json({ message: 'Public data' });
  });

  app.listen(3007);
}

// ============================================================================
// EXAMPLE 9: Redis-Based Distributed Rate Limiting
// ============================================================================

async function redisExample() {
  const app = express();

  // Create Redis-backed rate limiter
  const factory = await RedisRateLimiterFactory.create({
    host: 'localhost',
    port: 6379
  });

  // Use sliding window counter with Redis
  app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
    const limiter = factory.slidingWindow(
      req.ip || 'unknown',
      60,  // 60 second window
      100  // 100 requests max
    );

    const result = await limiter.consume();

    // Set headers
    res.setHeader('X-RateLimit-Limit', '100');
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      });
    }

    next();
  });

  app.get('/api/data', (req, res) => {
    res.json({ message: 'Data from distributed system' });
  });

  app.listen(3008);
}

// ============================================================================
// EXAMPLE 10: Direct Algorithm Usage (No Middleware)
// ============================================================================

async function directUsageExample() {
  // Token Bucket for API client
  const apiLimiter = new TokenBucketLimiter(100, 10);

  async function callExternalAPI() {
    const result = apiLimiter.allowRequest();

    if (!result.allowed) {
      console.log(`Rate limited. Retry after ${result.retryAfter}s`);
      await new Promise(resolve => setTimeout(resolve, result.retryAfter! * 1000));
      return callExternalAPI();
    }

    // Make API call
    console.log('API call made successfully');
    return { data: 'response' };
  }

  // Sliding Window for user actions
  const userActionLimiter = new SlidingWindowCounterLimiter(60, 50);

  function performUserAction(userId: string) {
    const result = userActionLimiter.allowRequest();

    if (!result.allowed) {
      throw new Error(`Too many actions. Try again in ${result.retryAfter}s`);
    }

    console.log(`Action performed. ${result.remaining} remaining`);
  }

  // Concurrent requests for database connections
  const dbLimiter = new ConcurrentRequestsLimiter(10);

  async function queryDatabase(query: string) {
    const result = dbLimiter.allowRequest();

    if (!result.allowed) {
      throw new Error('Too many concurrent database connections');
    }

    try {
      // Perform database query
      console.log('Querying database...');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { results: [] };
    } finally {
      dbLimiter.release();
    }
  }

  // Multi-tier for comprehensive limiting
  const comprehensiveLimiter = new MultiTierLimiter([
    new FixedWindowLimiter(1, 10),       // 10 per second
    new FixedWindowLimiter(60, 100),     // 100 per minute
    new FixedWindowLimiter(3600, 1000)   // 1000 per hour
  ]);

  async function performAction() {
    const result = await comprehensiveLimiter.allowRequest();

    if (!result.allowed) {
      console.log(`Rate limited at ${result.limit} requests per window`);
      return;
    }

    console.log('Action performed within all rate limits');
  }

  // Example calls
  await callExternalAPI();
  performUserAction('user123');
  await queryDatabase('SELECT * FROM users');
  await performAction();
}

// ============================================================================
// EXAMPLE 11: Rate Limiting Different HTTP Methods
// ============================================================================

function methodBasedRateLimiting() {
  const app = express();

  // Stricter limits for write operations
  const readLimiter = rateLimit({
    windowSize: 60,
    limit: 1000,
    skip: (req) => req.method !== 'GET'
  });

  const writeLimiter = rateLimit({
    windowSize: 60,
    limit: 100,
    skip: (req) => !['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)
  });

  app.use('/api', readLimiter, writeLimiter);

  app.get('/api/items', (req, res) => {
    res.json({ items: [] });
  });

  app.post('/api/items', (req, res) => {
    res.json({ created: true });
  });

  app.listen(3009);
}

// ============================================================================
// EXAMPLE 12: Rate Limiting with Cost-Based Tokens
// ============================================================================

function costBasedExample() {
  const app = express();
  const limiter = new TokenBucketLimiter(1000, 100);

  // Different endpoints consume different amounts of tokens
  app.get('/api/cheap', (req, res, next) => {
    const result = limiter.allowRequest(1); // Costs 1 token
    if (!result.allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    res.json({ cost: 1 });
  });

  app.get('/api/expensive', (req, res, next) => {
    const result = limiter.allowRequest(10); // Costs 10 tokens
    if (!result.allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    res.json({ cost: 10 });
  });

  app.listen(3010);
}

// ============================================================================
// Export all examples
// ============================================================================

export {
  basicExample,
  algorithmExamples,
  multiTierExample,
  perUserExample,
  tieredRateLimits,
  skipConditionsExample,
  customErrorHandlers,
  factoryExample,
  redisExample,
  directUsageExample,
  methodBasedRateLimiting,
  costBasedExample
};

// Run example
if (require.main === module) {
  console.log('Rate Limiter Examples');
  console.log('='.repeat(50));
  console.log('\nChoose an example to run:');
  console.log('1. Basic Example');
  console.log('2. Algorithm Examples');
  console.log('3. Multi-Tier Example');
  console.log('4. Per-User Example');
  console.log('5. Direct Usage Example');

  // Run direct usage example as default
  directUsageExample();
}
