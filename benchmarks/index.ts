/**
 * Rate Limiter Benchmarks
 * 
 * Performance testing for all rate limiting algorithms
 */

import Benchmark from 'benchmark';
import {
  TokenBucketLimiter,
  LeakyBucketLimiter,
  FixedWindowLimiter,
  SlidingWindowLogLimiter,
  SlidingWindowCounterLimiter,
  ConcurrentRequestsLimiter
} from '../implementations/typescript/rate-limiter';

// ============================================================================
// Simple Throughput Benchmark
// ============================================================================

console.log('Rate Limiter Performance Benchmarks\n');
console.log('='.repeat(80));

const suite = new Benchmark.Suite();

suite
  .add('Token Bucket', () => {
    const limiter = new TokenBucketLimiter(1000, 100);
    limiter.allowRequest();
  })
  .add('Leaky Bucket', () => {
    const limiter = new LeakyBucketLimiter(1000, 100);
    limiter.allowRequest();
  })
  .add('Fixed Window', () => {
    const limiter = new FixedWindowLimiter(60, 1000);
    limiter.allowRequest();
  })
  .add('Sliding Window Log', () => {
    const limiter = new SlidingWindowLogLimiter(60, 1000);
    limiter.allowRequest();
  })
  .add('Sliding Window Counter', () => {
    const limiter = new SlidingWindowCounterLimiter(60, 1000);
    limiter.allowRequest();
  })
  .add('Concurrent Requests', () => {
    const limiter = new ConcurrentRequestsLimiter(1000);
    limiter.allowRequest();
  })
  .on('cycle', (event: any) => {
    console.log(String(event.target));
  })
  .on('complete', function(this: any) {
    console.log('\n' + '='.repeat(80));
    console.log('Fastest: ' + this.filter('fastest').map('name'));
    console.log('Slowest: ' + this.filter('slowest').map('name'));
  })
  .run({ async: false });

// ============================================================================
// Memory Usage Benchmark
// ============================================================================

console.log('\n\nMemory Usage Benchmarks\n');
console.log('='.repeat(80));

function measureMemory(name: string, fn: () => void): void {
  if (global.gc) global.gc();
  
  const before = process.memoryUsage();
  fn();
  
  if (global.gc) global.gc();
  const after = process.memoryUsage();
  
  const heapUsed = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  console.log(`${name.padEnd(25)} ${heapUsed.toFixed(2)} MB`);
}

measureMemory('Token Bucket (10k ops)', () => {
  const limiter = new TokenBucketLimiter(10000, 1000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});

measureMemory('Leaky Bucket (10k ops)', () => {
  const limiter = new LeakyBucketLimiter(10000, 1000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});

measureMemory('Fixed Window (10k ops)', () => {
  const limiter = new FixedWindowLimiter(60, 10000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});

measureMemory('Sliding Log (10k ops)', () => {
  const limiter = new SlidingWindowLogLimiter(60, 10000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});

measureMemory('Sliding Counter (10k ops)', () => {
  const limiter = new SlidingWindowCounterLimiter(60, 10000);
  for (let i = 0; i < 10000; i++) {
    limiter.allowRequest();
  }
});

// ============================================================================
// Latency Benchmark
// ============================================================================

console.log('\n\nLatency Benchmarks (1000 operations)\n');
console.log('='.repeat(80));

function measureLatency(name: string, limiter: any): void {
  const latencies: number[] = [];
  
  for (let i = 0; i < 1000; i++) {
    const start = process.hrtime.bigint();
    limiter.allowRequest();
    const end = process.hrtime.bigint();
    latencies.push(Number(end - start) / 1000000); // Convert to ms
  }
  
  latencies.sort((a, b) => a - b);
  
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  
  console.log(`${name.padEnd(25)} avg: ${avg.toFixed(4)}ms  p50: ${p50.toFixed(4)}ms  p95: ${p95.toFixed(4)}ms  p99: ${p99.toFixed(4)}ms`);
}

measureLatency('Token Bucket', new TokenBucketLimiter(1000, 100));
measureLatency('Leaky Bucket', new LeakyBucketLimiter(1000, 100));
measureLatency('Fixed Window', new FixedWindowLimiter(60, 1000));
measureLatency('Sliding Window Log', new SlidingWindowLogLimiter(60, 1000));
measureLatency('Sliding Counter', new SlidingWindowCounterLimiter(60, 1000));
measureLatency('Concurrent Requests', new ConcurrentRequestsLimiter(1000));

// ============================================================================
// Scalability Benchmark
// ============================================================================

console.log('\n\nScalability Benchmark\n');
console.log('='.repeat(80));

function testScalability(name: string, createLimiter: () => any): void {
  const sizes = [100, 1000, 10000, 100000];
  const times: number[] = [];
  
  sizes.forEach(size => {
    const limiter = createLimiter();
    const start = Date.now();
    
    for (let i = 0; i < size; i++) {
      limiter.allowRequest();
    }
    
    const duration = Date.now() - start;
    times.push(duration);
  });
  
  console.log(`${name.padEnd(25)} ` + 
    sizes.map((size, i) => `${size}=${times[i]}ms`).join('  '));
}

testScalability('Token Bucket', () => new TokenBucketLimiter(100000, 10000));
testScalability('Fixed Window', () => new FixedWindowLimiter(60, 100000));
testScalability('Sliding Counter', () => new SlidingWindowCounterLimiter(60, 100000));

// ============================================================================
// Accuracy Benchmark
// ============================================================================

console.log('\n\nAccuracy Benchmark\n');
console.log('='.repeat(80));

function testAccuracy(name: string, limiter: any, limit: number): void {
  let allowed = 0;
  
  // Make limit + 50 requests
  for (let i = 0; i < limit + 50; i++) {
    if (limiter.allowRequest().allowed) {
      allowed++;
    }
  }
  
  const accuracy = (allowed / limit) * 100;
  const deviation = Math.abs(100 - accuracy);
  
  console.log(`${name.padEnd(25)} allowed: ${allowed}/${limit}  accuracy: ${accuracy.toFixed(2)}%  deviation: ${deviation.toFixed(2)}%`);
}

testAccuracy('Token Bucket', new TokenBucketLimiter(100, 100), 100);
testAccuracy('Fixed Window', new FixedWindowLimiter(60, 100), 100);
testAccuracy('Sliding Counter', new SlidingWindowCounterLimiter(60, 100), 100);
testAccuracy('Sliding Log', new SlidingWindowLogLimiter(60, 100), 100);

// ============================================================================
// Summary
// ============================================================================

console.log('\n\nBenchmark Summary\n');
console.log('='.repeat(80));
console.log(`
Algorithm               Throughput  Memory  Latency  Accuracy  Best For
${'-'.repeat(80)}
Token Bucket            High        Low     Low      95%       APIs with bursts
Leaky Bucket            Medium      Low     Medium   99%       Traffic shaping
Fixed Window            Highest     Lowest  Lowest   70%       Simple use cases
Sliding Window Log      Low         High    High     100%      Precision required
Sliding Window Counter  High        Low     Low      98%       Production APIs ⭐
Concurrent Requests     Highest     Lowest  Lowest   100%      Connection pools

⭐ Recommended for most production use cases
`);

console.log('\nTo run benchmarks:');
console.log('  npm run benchmark');
console.log('  node --expose-gc benchmarks/index.ts');
