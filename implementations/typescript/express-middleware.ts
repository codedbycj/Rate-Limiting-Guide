/**
 * Express Rate Limiting Middleware - TypeScript
 * 
 * Provides easy-to-use middleware for Express.js applications
 */

import { Request, Response, NextFunction } from 'express';
import {
  RateLimiter,
  TokenBucketLimiter,
  SlidingWindowCounterLimiter,
  FixedWindowLimiter,
  SlidingWindowLogLimiter,
  ConcurrentRequestsLimiter,
  RateLimitResult,
  RateLimitStorage,
  MemoryStorage
} from './rate-limiter';

/**
 * Middleware configuration options
 */
interface RateLimitMiddlewareConfig {
  // Rate limit parameters
  windowSize?: number;        // Window size in seconds (default: 60)
  limit?: number;             // Max requests per window (default: 100)

  // Algorithm selection
  algorithm?: 'token-bucket' | 'sliding-window-counter' | 'fixed-window' |
  'sliding-window-log' | 'concurrent';

  // Token bucket specific
  capacity?: number;          // Token bucket capacity
  refillRate?: number;        // Token bucket refill rate

  // Key generation
  keyGenerator?: (req: Request) => string;

  // Skip conditions
  skip?: (req: Request) => boolean;

  // Custom handlers
  onLimit?: (req: Request, res: Response, result: RateLimitResult) => void;
  handler?: (req: Request, res: Response, next: NextFunction) => void;

  // Headers
  standardHeaders?: boolean;   // Include X-RateLimit-* headers (default: true)
  legacyHeaders?: boolean;     // Include X-RateLimit-* without prefix (default: true)

  // Storage (for distributed rate limiting)
  storage?: RateLimitStorage;

  // Identifier for distributed limiting
  identifier?: string;

  // Skip successful requests
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

/**
 * Rate limit store for tracking limiters per key
 */
class RateLimiterStore {
  private limiters: Map<string, RateLimiter> = new Map();
  private config: RateLimitMiddlewareConfig;

  constructor(config: RateLimitMiddlewareConfig) {
    this.config = config;
  }

  getLimiter(key: string): RateLimiter {
    if (!this.limiters.has(key)) {
      this.limiters.set(key, this.createLimiter());
    }
    return this.limiters.get(key)!;
  }

  private createLimiter(): RateLimiter {
    const {
      algorithm = 'sliding-window-counter',
      windowSize = 60,
      limit = 100,
      capacity,
      refillRate
    } = this.config;

    switch (algorithm) {
      case 'token-bucket':
        return new TokenBucketLimiter(
          capacity || limit,
          refillRate || limit / windowSize
        );

      case 'fixed-window':
        return new FixedWindowLimiter(windowSize, limit);

      case 'sliding-window-log':
        return new SlidingWindowLogLimiter(windowSize, limit);

      case 'concurrent':
        return new ConcurrentRequestsLimiter(limit);

      case 'sliding-window-counter':
      default:
        return new SlidingWindowCounterLimiter(windowSize, limit);
    }
  }

  clear(): void {
    this.limiters.clear();
  }
}

/**
 * Create rate limit middleware
 */
export function rateLimit(config: RateLimitMiddlewareConfig = {}) {
  const {
    keyGenerator = (req: Request) => req.ip || 'unknown',
    skip = () => false,
    handler,
    onLimit,
    standardHeaders = true,
    legacyHeaders = true,
    skipSuccessfulRequests = false,
    skipFailedRequests = false
  } = config;

  const store = new RateLimiterStore(config);

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if skip function returns true
    if (skip(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const limiter = store.getLimiter(key);

    try {
      const result = await Promise.resolve(limiter.allowRequest());

      // Set headers
      if (standardHeaders || legacyHeaders) {
        const prefix = standardHeaders ? 'RateLimit-' : 'X-RateLimit-';

        res.setHeader(`${prefix}Limit`, result.limit.toString());
        res.setHeader(`${prefix}Remaining`, result.remaining.toString());
        res.setHeader(`${prefix}Reset`, Math.ceil(result.resetAt / 1000).toString());

        if (legacyHeaders) {
          res.setHeader('X-RateLimit-Limit', result.limit.toString());
          res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
          res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());
        }
      }

      if (!result.allowed) {
        if (result.retryAfter) {
          res.setHeader('Retry-After', Math.ceil(result.retryAfter).toString());
        }

        if (onLimit) {
          onLimit(req, res, result);
        }

        if (handler) {
          return handler(req, res, next);
        }

        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: result.retryAfter ? Math.ceil(result.retryAfter) : undefined
        });
      }

      // Handle response completion for concurrent limiter
      if (limiter instanceof ConcurrentRequestsLimiter) {
        res.on('finish', () => {
          limiter.release();
        });
        res.on('close', () => {
          limiter.release();
        });
      }

      // Skip counting based on response status
      if (skipSuccessfulRequests || skipFailedRequests) {
        const originalSend = res.send;
        res.send = function (data: any) {
          const statusCode = res.statusCode;

          if ((skipSuccessfulRequests && statusCode < 400) ||
            (skipFailedRequests && statusCode >= 400)) {
            // Rollback the rate limit
            // This would need implementation in the limiter classes
          }

          return originalSend.call(this, data);
        };
      }

      next();
    } catch (error) {
      console.error('Rate limiter error:', error);
      // Fail open - allow request if rate limiter fails
      next();
    }
  };
}

/**
 * Create multi-tier rate limiter
 * Example: 10/second AND 1000/hour
 */
export function multiTierRateLimit(configs: RateLimitMiddlewareConfig[]) {
  const middlewares = configs.map(config => rateLimit(config));

  return async (req: Request, res: Response, next: NextFunction) => {
    let index = 0;

    const runNext = () => {
      if (index >= middlewares.length) {
        return next();
      }

      const middleware = middlewares[index++];
      middleware(req, res, (err?: any) => {
        if (err) return next(err);
        if (res.headersSent) return; // Rate limit hit
        runNext();
      });
    };

    runNext();
  };
}

/**
 * Per-route rate limiter factory
 */
export class RateLimitFactory {
  private defaultConfig: RateLimitMiddlewareConfig;

  constructor(defaultConfig: RateLimitMiddlewareConfig = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Create a rate limiter with custom config merged with defaults
   */
  create(config: RateLimitMiddlewareConfig = {}) {
    return rateLimit({ ...this.defaultConfig, ...config });
  }

  /**
   * Strict rate limiter (lower limits)
   */
  strict(windowSize: number = 60, limit: number = 10) {
    return this.create({ windowSize, limit });
  }

  /**
   * Standard rate limiter (moderate limits)
   */
  standard(windowSize: number = 60, limit: number = 100) {
    return this.create({ windowSize, limit });
  }

  /**
   * Permissive rate limiter (higher limits)
   */
  permissive(windowSize: number = 60, limit: number = 1000) {
    return this.create({ windowSize, limit });
  }

  /**
   * Per-user rate limiter
   */
  perUser(getUserId: (req: Request) => string, limit: number = 100) {
    return this.create({
      limit,
      keyGenerator: (req) => `user:${getUserId(req)}`
    });
  }

  /**
   * Per-IP rate limiter
   */
  perIP(limit: number = 100) {
    return this.create({
      limit,
      keyGenerator: (req) => `ip:${req.ip}`
    });
  }

  /**
   * Per-API key rate limiter
   */
  perApiKey(getApiKey: (req: Request) => string, limit: number = 1000) {
    return this.create({
      limit,
      keyGenerator: (req) => `api_key:${getApiKey(req)}`
    });
  }
}

/**
 * Decorator for rate limiting class methods
 */
export function RateLimit(config: RateLimitMiddlewareConfig = {}) {
  const limiter = new SlidingWindowCounterLimiter(
    config.windowSize || 60,
    config.limit || 100
  );

  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await Promise.resolve(limiter.allowRequest());

      if (!result.allowed) {
        throw new Error(`Rate limit exceeded. Retry after ${result.retryAfter}s`);
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}

/**
 * Example usage
 */
export function exampleUsage() {
  const express = require('express');
  const app = express();

  // Basic usage - 100 requests per minute
  app.use('/api/', rateLimit({
    windowSize: 60,
    limit: 100
  }));

  // Per-user rate limiting
  app.use('/api/user', rateLimit({
    windowSize: 60,
    limit: 30,
    keyGenerator: (req) => (req as any).user?.id || req.ip
  }));

  // Multi-tier: 10/second AND 1000/hour
  app.use('/api/strict', multiTierRateLimit([
    { windowSize: 1, limit: 10 },
    { windowSize: 3600, limit: 1000 }
  ]));

  // Custom error handler
  app.use('/api/custom', rateLimit({
    windowSize: 60,
    limit: 50,
    handler: (req, res) => {
      res.status(429).json({
        error: 'Slow down!',
        message: 'You are being rate limited'
      });
    }
  }));

  // Skip premium users
  app.use('/api/conditional', rateLimit({
    windowSize: 60,
    limit: 100,
    skip: (req) => (req as any).user?.isPremium === true
  }));

  // Different limits per endpoint
  const factory = new RateLimitFactory({ windowSize: 60 });

  app.get('/api/public', factory.permissive(60, 1000), (req: Request, res: Response) => {
    res.json({ message: 'Public endpoint' });
  });

  app.post('/api/login', factory.strict(300, 5), (req: Request, res: Response) => {
    res.json({ message: 'Login endpoint' });
  });

  app.get('/api/data', factory.perUser(
    (req) => (req as any).user?.id,
    100
  ), (req: Request, res: Response) => {
    res.json({ message: 'User data' });
  });

  // Token bucket for burst support
  app.use('/api/burst', rateLimit({
    algorithm: 'token-bucket',
    capacity: 100,
    refillRate: 10 // 10 tokens per second
  }));

  // Concurrent requests limiter
  app.use('/api/concurrent', rateLimit({
    algorithm: 'concurrent',
    limit: 10 // Max 10 concurrent requests
  }));

  app.listen(3000, () => {
    console.log('Server running on port 3000');
  });
}

// Export types and functions
export {
  RateLimitMiddlewareConfig,
  RateLimitResult
};
