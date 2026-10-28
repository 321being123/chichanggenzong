// 每日快照一致性统计，读取仍由仓储执行。
const { dailyConsistencyStats } = require('../repositories/consistencyStatsRepository');

module.exports = { dailyConsistencyStats };
