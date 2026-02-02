/**
 * API Gateway Example with Rate Limiting
 * 
 * Demonstrates comprehensive rate limiting in an API gateway scenario
 */

import express, { Request, Response, NextFunction } from 'express';
import { rateLimit, RateLimitFactory, multiTierRateLimit } from '../../implementations/typescript/express-middleware';
import { RedisRateLimiterFactory } from '../../implementations/typescript/redis-adapter';

const app = express();
app.use(express.json());

// Initialize Redis for distributed rate limiting
let redisFactory: RedisRateLimiterFactory;

async function initializeRedis() {
  redisFactory = await RedisRateLimiterFactory.create({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  });
}

// ============================================================================
// Authentication Middleware
// ============================================================================

interface User {
  id: string;
  email: string;
  tier: 'free' | 'premium' | 'enterprise';
  apiKey: string;
}

interface AuthRequest extends Request {
  user?: User;
}

const users: Map<string, User> = new Map([
  ['free-key', { id: '1', email: 'free@example.com', tier: 'free', apiKey: 'free-key' }],
  ['premium-key', { id: '2', email: 'premium@example.com', tier: 'premium', apiKey: 'premium-key' }],
  ['enterprise-key', { id: '3', email: 'enterprise@example.com', tier: 'enterprise', apiKey: 'enterprise-key' }]
]);

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  const user = users.get(apiKey);
  if (!user) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.user = user;
  next();
}

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

// Global rate limit (all users)
const globalLimiter = rateLimit({
  windowSize: 1,
  limit: 1000, // 1000 req/second globally
  keyGenerator: () => 'global',
  handler: (req, res) => {
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'System is under heavy load. Please try again later.'
    });
  }
});

// Per-IP rate limit (prevent abuse)
const ipLimiter = rateLimit({
  windowSize: 60,
  limit: 100, // 100 req/minute per IP
  keyGenerator: (req) => req.ip || 'unknown',
  skip: (req: AuthRequest) => {
    // Skip for authenticated enterprise users
    return req.user?.tier === 'enterprise';
  }
});

// Tiered rate limits based on user plan
function createTieredLimiter() {
  const factory = new RateLimitFactory();

  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limits = {
      free: { windowSize: 60, limit: 10 },        // 10/minute
      premium: { windowSize: 60, limit: 100 },     // 100/minute
      enterprise: { windowSize: 60, limit: 1000 }  // 1000/minute
    };

    const config = limits[req.user.tier];
    const limiter = factory.create({
      ...config,
      keyGenerator: (req: AuthRequest) => `user:${req.user!.id}`
    });

    limiter(req, res, next);
  };
}

// Endpoint-specific rate limits
const authLimiter = rateLimit({
  windowSize: 900, // 15 minutes
  limit: 5, // 5 attempts
  keyGenerator: (req) => `auth:${req.ip}`,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too Many Attempts',
      message: 'Too many authentication attempts. Please try again in 15 minutes.'
    });
  }
});

// Expensive operation rate limit
const heavyOperationLimiter = rateLimit({
  windowSize: 3600, // 1 hour
  limit: 10, // 10/hour
  keyGenerator: (req: AuthRequest) => `heavy:${req.user?.id || req.ip}`
});

// ============================================================================
// Apply Rate Limiters
// ============================================================================

// Global limits apply to all routes
app.use(globalLimiter);
app.use(ipLimiter);

// Authentication required routes
app.use('/api', authMiddleware);
app.use('/api', createTieredLimiter());

// ============================================================================
// Routes
// ============================================================================

// Health check (no rate limit)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Authentication endpoint (strict rate limit)
app.post('/auth/login', authLimiter, (req: AuthRequest, res) => {
  const { email, password } = req.body;
  
  // Simulate authentication
  const user = Array.from(users.values()).find(u => u.email === email);
  
  if (!user || password !== 'password') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({
    token: user.apiKey,
    user: {
      id: user.id,
      email: user.email,
      tier: user.tier
    }
  });
});

// Public API (uses tiered limits)
app.get('/api/data', (req: AuthRequest, res) => {
  res.json({
    data: 'Sample data',
    user: req.user?.email,
    tier: req.user?.tier
  });
});

// Expensive operation (additional rate limit)
app.post('/api/export', heavyOperationLimiter, (req: AuthRequest, res) => {
  // Simulate expensive operation
  res.json({
    message: 'Export started',
    estimatedTime: '5 minutes'
  });
});

// Multi-tier endpoint: 10/second AND 1000/hour
app.get('/api/search', multiTierRateLimit([
  { windowSize: 1, limit: 10 },       // 10/second
  { windowSize: 3600, limit: 1000 }   // 1000/hour
]), (req: AuthRequest, res) => {
  res.json({
    results: ['result1', 'result2', 'result3']
  });
});

// Admin endpoint (whitelisted)
app.get('/admin/stats', 
  (req: AuthRequest, res, next) => {
    if (req.user?.tier !== 'enterprise') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  },
  (req: AuthRequest, res) => {
    res.json({
      totalUsers: users.size,
      activeConnections: 42,
      requestsPerSecond: 150
    });
  }
);

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Initialize Redis
    await initializeRedis();
    console.log('✓ Redis connected');

    // Start server
    app.listen(PORT, () => {
      console.log(`✓ API Gateway running on port ${PORT}`);
      console.log('\nAPI Endpoints:');
      console.log('  POST /auth/login           - Login (5 req/15min per IP)');
      console.log('  GET  /api/data             - Get data (tiered limits)');
      console.log('  POST /api/export           - Export data (10 req/hour)');
      console.log('  GET  /api/search           - Search (10/sec, 1000/hour)');
      console.log('  GET  /admin/stats          - Admin stats (enterprise only)');
      console.log('\nRate Limits by Tier:');
      console.log('  Free:       10 requests/minute');
      console.log('  Premium:    100 requests/minute');
      console.log('  Enterprise: 1000 requests/minute');
      console.log('\nTest with:');
      console.log('  curl -H "X-API-Key: free-key" http://localhost:3000/api/data');
      console.log('  curl -H "X-API-Key: premium-key" http://localhost:3000/api/data');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (redisFactory) {
    await redisFactory.close();
  }
  process.exit(0);
});

// Start if run directly
if (require.main === module) {
  start();
}

export default app;
