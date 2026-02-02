# Rate Limiting Best Practices

## 1. Choose the Right Algorithm

### Decision Matrix

| Requirement | Recommended Algorithm |
|-------------|----------------------|
| Production API | Sliding Window Counter |
| Need bursts | Token Bucket |
| Strict output rate | Leaky Bucket |
| Perfect accuracy | Sliding Window Log |
| Simplest implementation | Fixed Window |
| Connection limiting | Concurrent Requests |

## 2. Set Appropriate Limits

### Calculate Based on Capacity

```typescript
// Example: Database can handle 1000 queries/second
const dbCapacity = 1000;
const safetyMargin = 0.2; // 20% buffer
const limit = dbCapacity * (1 - safetyMargin); // 800/second

const limiter = new TokenBucketLimiter(limit, limit);
```

### Tiered Limits by User Type

```typescript
const limits = {
  free: { rps: 10, daily: 1000 },
  premium: { rps: 100, daily: 100000 },
  enterprise: { rps: 1000, daily: 10000000 }
};
```

## 3. Communicate Limits Clearly

### Standard Headers

Always include:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 73
X-RateLimit-Reset: 1640995200
Retry-After: 30
```

### Error Messages

```json
{
  "error": "rate_limit_exceeded",
  "message": "You have exceeded your rate limit of 100 requests per minute",
  "limit": 100,
  "remaining": 0,
  "reset": 1640995200,
  "retryAfter": 30
}
```

## 4. Implement Graceful Degradation

```typescript
async function handleRequest(req, res) {
  const result = await rateLimiter.checkLimit(req.user.id);
  
  if (!result.allowed) {
    // Degrade service instead of hard reject
    if (req.user.tier === 'premium') {
      // Allow with reduced functionality
      return handleReducedRequest(req, res);
    }
    
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Upgrade to premium for higher limits'
    });
  }
  
  return handleFullRequest(req, res);
}
```

## 5. Monitor and Alert

```typescript
const metrics = {
  totalRequests: 0,
  rateLimitHits: 0,
  averageUtilization: 0
};

// Alert if rejection rate > 5%
if (metrics.rateLimitHits / metrics.totalRequests > 0.05) {
  alertOps('High rate limit rejection rate');
}
```

## 6. Test Thoroughly

### Load Testing

```typescript
// Simulate 1000 concurrent users
async function loadTest() {
  const promises = Array(1000).fill(null).map(async () => {
    for (let i = 0; i < 100; i++) {
      await makeRequest();
    }
  });
  
  await Promise.all(promises);
}
```

### Boundary Testing

```typescript
test('should handle window boundaries', async () => {
  // Make requests at window boundary
  await sleep(990); // Near end of window
  const results = await makeRequests(100);
  
  await sleep(20); // Cross boundary
  const results2 = await makeRequests(100);
  
  // Verify correct behavior
});
```

## 7. Fail Safe

```typescript
try {
  const allowed = await rateLimiter.checkLimit(userId);
  if (!allowed) {
    return reject();
  }
} catch (error) {
  console.error('Rate limiter error:', error);
  // Fail open - allow request if rate limiter is down
  metrics.increment('rate_limiter.error');
  return allow();
}
```

## 8. Document Limits

Include in API documentation:
- Rate limits per endpoint
- How limits are calculated
- Headers returned
- How to handle 429 responses
- How to request limit increases

## 9. Provide Webhooks

```typescript
// Notify users when approaching limit
if (result.remaining < result.limit * 0.1) {
  sendWebhook(user.webhookUrl, {
    event: 'rate_limit_warning',
    remaining: result.remaining,
    resetAt: result.resetAt
  });
}
```

## 10. Support Whitelisting

```typescript
const whitelist = new Set(['admin-api-key', 'monitoring-service']);

function checkRateLimit(apiKey: string) {
  if (whitelist.has(apiKey)) {
    return { allowed: true };
  }
  return rateLimiter.checkLimit(apiKey);
}
```

## Common Pitfalls to Avoid

### ❌ Don't:
- Use in-memory limiters in multi-instance deployments
- Forget to handle rate limiter failures
- Set limits too low (test under real load)
- Ignore monitoring and alerting
- Hard-code limits in application

### ✅ Do:
- Use distributed limiters (Redis) for production
- Implement circuit breakers
- Test with realistic traffic
- Monitor rejection rates
- Make limits configurable
- Document clearly
- Provide upgrade paths

## Security Considerations

1. **DDoS Protection**: Rate limit at multiple levels (IP, user, endpoint)
2. **Brute Force Prevention**: Strict limits on authentication endpoints
3. **Resource Protection**: Different limits for expensive operations
4. **Fair Usage**: Prevent single user from monopolizing resources

## Performance Tips

1. **Cache Results**: Short-lived local cache can reduce Redis calls
2. **Batch Operations**: Use Redis pipelines for multiple checks
3. **Optimize Keys**: Short, consistent key naming
4. **Monitor Latency**: Alert on slow rate limit checks
5. **Use Appropriate Data Structures**: Choose algorithm based on traffic patterns
