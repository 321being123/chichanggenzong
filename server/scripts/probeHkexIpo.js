// 港交所 IPO 入口探针；默认只读，--persist 才把探针摘要写入 ops 审计表。
// 用法：node server/scripts/probeHkexIpo.js [--json] [--persist] [--environment=local|server]
require('dotenv').config();
const { runHkexIpoProbe, persistHkexProbe } = require('../services/hkexIpo');

(async () => {
  const result = await runHkexIpoProbe();
  if (process.argv.includes('--persist')) {
    const environmentArg = process.argv.find(arg => arg.startsWith('--environment='));
    const environment = environmentArg ? environmentArg.slice('--environment='.length) : 'local';
    result.persistence = await persistHkexProbe(result, { environment });
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  for (const target of result.targets) {
    const status = target.ok ? 'OK' : 'FAILED';
    console.log(`[hkex-probe] ${status} ${target.key} ${target.url} rows=${target.rowCount || 0}`);
    if (!target.ok) console.log(`  error=${target.error}`);
  }
})().catch(error => {
  console.error('[hkex-probe] failed:', error.message || error);
  process.exitCode = 1;
});
