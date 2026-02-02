# Concurrent Requests Limiter

## Overview

Limits the number of simultaneous active requests rather than rate per time window.

## How It Works

1. Track count of active requests
2. Increment on request start
3. Decrement on request completion
4. Reject if at max concurrency

## Implementation

```typescript
export class ConcurrentRequestsLimiter {
  private maxConcurrent: number;
  private activeRequests: number = 0;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  allowRequest(): RateLimitResult {
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return { allowed: true, remaining: this.maxConcurrent - this.activeRequests };
    }
    return { allowed: false, remaining: 0 };
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }
}
```

## Use Cases

- Database connection pools
- WebSocket connections
- Long-running operations
- Resource-limited services

## Usage Pattern

```typescript
const limiter = new ConcurrentRequestsLimiter(10);

async function handleRequest() {
  if (!limiter.allowRequest().allowed) {
    throw new Error('Too many concurrent requests');
  }

  try {
    await processRequest();
  } finally {
    limiter.release(); // Always release!
  }
}
```
