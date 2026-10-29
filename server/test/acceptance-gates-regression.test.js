const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { providerMappingEntrypoints } = require('../scripts/acceptanceDataArchitecture');
const { matrixMatches } = require('../../scripts/generate-job-matrix');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const inputs = {
  identityJs: read('server/services/securityIdentity.js'),
  marketRoute: read('server/routes/market.js'),
  announcementAdapter: read('server/dataAccess/adapters/announcementSourceAdapter.js'),
  tencentQuote: read('server/services/tencentQuote.js'),
  pythonIdentity: read('ipo-report/instrument_identity.py'),
  pythonQuote: read('ipo-report/ipo_lib_common.py'),
};
assert(providerMappingEntrypoints(inputs), '验收应检查实际公告适配器');
assert(!providerMappingEntrypoints({ ...inputs, announcementAdapter: inputs.announcementAdapter.replace("sourceCode: 'xueqiu'", "sourceCode: 'other'") }), '缺少雪球映射应失败');
assert(!providerMappingEntrypoints({ ...inputs, announcementAdapter: inputs.announcementAdapter.replace("sourceCode: 'eastmoney', identifierType: 'guba_code'", "sourceCode: 'other'") }), '缺少股吧映射应失败');
assert(matrixMatches('a\r\nb\r\n', 'a\nb\n'), 'CRLF 与 LF 内容应等价');
assert(!matrixMatches('a\r\nc\r\n', 'a\nb\n'), '内容变化不能因换行归一化被忽略');
console.log('验收映射入口及矩阵换行回归通过');
