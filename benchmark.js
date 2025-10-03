'use strict';

const http = require('http');
const Agent = require('./index');
const OriginalAgent = require('http').Agent;

// Performance metrics collector
class BenchmarkMetrics {
  constructor(name) {
    this.name = name;
    this.startTime = 0;
    this.endTime = 0;
    this.operations = 0;
    this.errors = 0;
    this.socketCreations = 0;
    this.socketReuses = 0;
  }

  start() {
    this.startTime = Date.now();
  }

  end() {
    this.endTime = Date.now();
  }

  get duration() {
    return this.endTime - this.startTime;
  }

  get opsPerSecond() {
    return Math.round((this.operations / this.duration) * 1000);
  }

  get avgResponseTime() {
    return (this.duration / this.operations).toFixed(2);
  }

  print() {
    console.log(`\n=== ${this.name} ===`);
    console.log(`Total operations: ${this.operations}`);
    console.log(`Duration: ${this.duration}ms`);
    console.log(`Operations/sec: ${this.opsPerSecond}`);
    console.log(`Avg response time: ${this.avgResponseTime}ms`);
    console.log(`Errors: ${this.errors}`);
    console.log(`Socket creations: ${this.socketCreations}`);
    console.log(`Socket reuses: ${this.socketReuses}`);
    console.log(`Keep-alive effectiveness: ${((this.socketReuses / this.operations) * 100).toFixed(2)}%`);
  }
}

// Create a simple HTTP server for benchmarking
function createTestServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });
  return server;
}

// Benchmark socket creation and reuse
async function benchmarkSocketReuse(agent, metrics, totalRequests) {
  return new Promise((resolve) => {
    let completed = 0;
    let inFlight = 0;
    const maxConcurrent = 50;

    function makeRequest() {
      if (completed >= totalRequests) {
        return;
      }

      if (inFlight >= maxConcurrent) {
        return;
      }

      inFlight++;
      const req = http.request({
        hostname: 'localhost',
        port: 8888,
        path: '/',
        method: 'GET',
        agent: agent,
      }, (res) => {
        if (req.reusedSocket) {
          metrics.socketReuses++;
        } else {
          metrics.socketCreations++;
        }

        res.on('data', () => {});
        res.on('end', () => {
          completed++;
          inFlight--;
          metrics.operations++;

          if (completed >= totalRequests) {
            resolve();
          } else {
            makeRequest();
          }
        });
      });

      req.on('error', (err) => {
        metrics.errors++;
        completed++;
        inFlight--;
        if (completed >= totalRequests) {
          resolve();
        } else {
          makeRequest();
        }
      });

      req.end();

      // Immediately queue next request
      setImmediate(makeRequest);
    }

    // Start initial batch
    for (let i = 0; i < maxConcurrent; i++) {
      makeRequest();
    }
  });
}

// Benchmark connection establishment time
async function benchmarkConnectionTime(agent, metrics, totalRequests) {
  return new Promise((resolve) => {
    let completed = 0;

    function makeRequest() {
      if (completed >= totalRequests) {
        resolve();
        return;
      }

      const startTime = Date.now();
      const req = http.request({
        hostname: 'localhost',
        port: 8888,
        path: '/',
        method: 'GET',
        agent: agent,
      }, (res) => {
        const endTime = Date.now();
        const connTime = endTime - startTime;

        if (req.reusedSocket) {
          metrics.socketReuses++;
        } else {
          metrics.socketCreations++;
        }

        res.on('data', () => {});
        res.on('end', () => {
          completed++;
          metrics.operations++;
          makeRequest();
        });
      });

      req.on('error', (err) => {
        metrics.errors++;
        completed++;
        makeRequest();
      });

      req.end();
    }

    makeRequest();
  });
}

// Benchmark burst traffic
async function benchmarkBurstTraffic(agent, metrics, burstSize) {
  const promises = [];

  for (let i = 0; i < burstSize; i++) {
    const promise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 8888,
        path: '/',
        method: 'GET',
        agent: agent,
      }, (res) => {
        if (req.reusedSocket) {
          metrics.socketReuses++;
        } else {
          metrics.socketCreations++;
        }

        res.on('data', () => {});
        res.on('end', () => {
          metrics.operations++;
          resolve();
        });
      });

      req.on('error', (err) => {
        metrics.errors++;
        reject(err);
      });

      req.end();
    });

    promises.push(promise.catch(() => {}));
  }

  await Promise.all(promises);
}

// Main benchmark runner
async function runBenchmarks() {
  console.log('Starting agentkeepalive performance benchmarks...\n');

  const server = createTestServer();
  await new Promise(resolve => {
    server.listen(8888, resolve);
  });

  console.log('Test server started on port 8888');

  // Benchmark 1: Sequential requests with keepalive agent
  {
    const metrics = new BenchmarkMetrics('Optimized Agent - Sequential Requests');
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 10,
      timeout: 30000,
      freeSocketTimeout: 15000,
    });

    metrics.start();
    await benchmarkSocketReuse(agent, metrics, 1000);
    metrics.end();
    metrics.print();

    agent.destroy();
  }

  // Benchmark 2: Sequential requests with standard agent
  {
    const metrics = new BenchmarkMetrics('Standard Agent - Sequential Requests');
    const agent = new OriginalAgent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 10,
      timeout: 30000,
    });

    metrics.start();
    await benchmarkSocketReuse(agent, metrics, 1000);
    metrics.end();
    metrics.print();

    agent.destroy();
  }

  // Benchmark 3: Connection time with optimized agent
  {
    const metrics = new BenchmarkMetrics('Optimized Agent - Connection Time');
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 5,
      maxFreeSockets: 5,
      timeout: 30000,
      freeSocketTimeout: 15000,
    });

    metrics.start();
    await benchmarkConnectionTime(agent, metrics, 500);
    metrics.end();
    metrics.print();

    agent.destroy();
  }

  // Benchmark 4: Burst traffic with optimized agent
  {
    const metrics = new BenchmarkMetrics('Optimized Agent - Burst Traffic (100 concurrent)');
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 50,
      timeout: 30000,
      freeSocketTimeout: 15000,
    });

    metrics.start();
    await benchmarkBurstTraffic(agent, metrics, 100);
    metrics.end();
    metrics.print();

    agent.destroy();
  }

  // Benchmark 5: Burst traffic with standard agent
  {
    const metrics = new BenchmarkMetrics('Standard Agent - Burst Traffic (100 concurrent)');
    const agent = new OriginalAgent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 50,
      timeout: 30000,
    });

    metrics.start();
    await benchmarkBurstTraffic(agent, metrics, 100);
    metrics.end();
    metrics.print();

    agent.destroy();
  }

  // Benchmark 6: High throughput test
  {
    const metrics = new BenchmarkMetrics('Optimized Agent - High Throughput (5000 requests)');
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 20,
      maxFreeSockets: 20,
      timeout: 30000,
      freeSocketTimeout: 15000,
    });

    metrics.start();
    await benchmarkSocketReuse(agent, metrics, 5000);
    metrics.end();
    metrics.print();

    const status = agent.getCurrentStatus();
    console.log('\nAgent Status:');
    console.log(`  Total sockets created: ${status.createSocketCount}`);
    console.log(`  Total requests handled: ${status.requestCount}`);
    console.log(`  Socket errors: ${status.errorSocketCount}`);
    console.log(`  Socket timeouts: ${status.timeoutSocketCount}`);

    agent.destroy();
  }

  server.close();
  console.log('\n\nBenchmarks completed!');
}

// Run benchmarks
if (require.main === module) {
  runBenchmarks().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}

module.exports = { runBenchmarks };
