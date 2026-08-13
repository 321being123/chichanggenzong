const assert = require('assert');
const { sanitizeJobError, sanitizeJobResult } = require('../services/jobErrorSanitizer');

const source = [
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijk.abcdefghijkl',
  'password=plain-secret',
  'api_key: "key-value-123"',
  'postgresql://portfolio:db-password@example.com/app',
  'mysql://portfolio:mysql-password@example.com/app',
  'redis://:redis-password@example.com/0',
  'https://example.com/api?token=query-secret&code=500',
  'DB_PASS=db-pass-secret',
  'apiSecretKey=api-secret-value',
].join('\n');
const result = sanitizeJobError(source);

for (const secret of ['plain-secret', 'key-value-123', 'db-password', 'mysql-password', 'redis-password', 'query-secret', 'db-pass-secret', 'api-secret-value', 'abcdefghijklmnopqrstuvwxyz']) {
  assert(!result.includes(secret), `敏感值未脱敏：${secret}`);
}
assert(result.includes('[已脱敏]'), '脱敏结果应保留明确占位符');
assert.strictEqual(sanitizeJobError('1234567890', 5), '12345', '错误摘要必须限制长度');
for (const normal of ['compass=west', 'bypass=true', 'tokenCount=1200', 'secretary=Alice',
  'passwordResetAt=2026-08-13', 'secretCode=500', 'authorizationStatus=failed']) {
  assert.strictEqual(sanitizeJobError(normal), normal, `正常诊断字段不应被误脱敏：${normal}`);
}
const nested = sanitizeJobResult({
  token: 'raw-token',
  accessToken: 'raw-access-token',
  clientSecret: 'raw-client-secret',
  smtpPass: 'raw-smtp-pass',
  connectionString: 'mongodb://u:raw-db-password@db/app',
  refreshToken: 'raw-refresh-token',
  dbPassword: 'raw-db-field-password',
  smtpPassword: 'raw-smtp-password',
  OPENAI_API_KEY: 'raw-openai-key',
  TUSHARE_TOKEN: 'raw-tushare-token',
  apiSecretKey: 'raw-api-secret-key',
  credentials: 'raw-credentials',
  error: 'password=nested-secret',
  rows: [{ database_url: 'postgresql://u:p@db/app' }],
});
assert.strictEqual(nested.token, '[已脱敏]');
assert(!JSON.stringify(nested).includes('nested-secret'));
assert(!JSON.stringify(nested).includes('postgresql://u:p@'));
for (const secret of [
  'raw-access-token', 'raw-client-secret', 'raw-smtp-pass', 'raw-db-password',
  'raw-refresh-token', 'raw-db-field-password', 'raw-smtp-password', 'raw-openai-key', 'raw-tushare-token',
  'raw-api-secret-key', 'raw-credentials',
]) {
  assert(!JSON.stringify(nested).includes(secret), `嵌套敏感值未脱敏：${secret}`);
}
const normalResult = sanitizeJobResult({
  compass: 'west', bypass: true, tokenCount: 1200, secretary: 'Alice',
  passwordResetAt: '2026-08-13', secretCode: 500, authorizationStatus: 'failed',
});
assert.deepStrictEqual(normalResult, {
  compass: 'west', bypass: true, tokenCount: 1200, secretary: 'Alice',
  passwordResetAt: '2026-08-13', secretCode: 500, authorizationStatus: 'failed',
});

console.log('OK job-error-sanitizer: 敏感错误摘要脱敏通过');
