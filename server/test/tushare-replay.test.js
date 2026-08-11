const assert = require('assert');
const {
  DEFAULT_BASE_URL,
  buildReplayUrl,
  replayApiKey,
} = require('../services/tushareReplay');

const url = buildReplayUrl(
  'new_share',
  { start_date: '20260701', end_date: '20260811', limit: 5 },
  'ts_code,name,ipo_date',
  { TUSHARE_REPLAY_BASE_URL: DEFAULT_BASE_URL, TUSHARE_REPLAY_API_KEY: 'test-key' },
);
assert.strictEqual(url.origin, 'https://ai-tool.indevs.in');
assert.strictEqual(url.pathname, '/tushare/pro/new_share');
assert.strictEqual(url.searchParams.get('start_date'), '20260701');
assert.strictEqual(url.searchParams.get('fields'), 'ts_code,name,ipo_date');
assert.strictEqual(replayApiKey({ TUSHARE_REPLAY_API_KEY: ' test-key ' }), 'test-key');
assert.strictEqual(replayApiKey({}), '');

console.log('OK tushare-replay: GET URL、查询参数和 X-API-Key 配置校验通过');
