const fs = require('node:fs');

const targetLog = process.env.MY_SEARCH_BENCHMARK_MEMORY_LOG;
const serverArgument = process.argv.some((argument) => /(?:^|[\\/])server\.(?:ts|js|mjs)$/i.test(argument));
const isRunner = process.argv.some((argument) => /(?:^|[\\/])(?:n?px?-cli\.(?:js|mjs)|tsx[\\/].*cli\.(?:js|mjs))$/i.test(argument));

if (targetLog && serverArgument && !isRunner) {
  const writeSample = () => {
    const memory = process.memoryUsage();
    fs.appendFileSync(targetLog, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      role: 'api-server',
      entrypoint: process.argv[1] ?? null,
      scriptArgument: process.argv.find((argument) => /(?:^|[\\/])server\.(?:ts|js|mjs)$/i.test(argument)) ?? null,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    })}\n`);
  };
  writeSample();
  const timer = setInterval(writeSample, 1000);
  timer.unref();
}
