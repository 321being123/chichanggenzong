// PB 投影读开关（2026-11-28）。
//
// 生产默认关闭：投影必须先完成历史回填并通过抽样对账，部署流程才把
// PB_PROJECTION_READ_ENABLED 置 1；未回填时读投影会抛 PB_PROJECTION_NOT_READY。
// 非生产（开发/测试）默认开启，便于本地与等价测试直接验证投影读路径；
// 显式设置 0/false/no/off 可在任何环境一键回退原 daily_valuations 查询。
// 放在 domain 是因为它是纯策略判定；仓储读取该纯函数属于依赖倒置允许范围。
'use strict';

function projectionReadEnabled() {
  const raw = process.env.PB_PROJECTION_READ_ENABLED;
  if (raw === undefined || raw === null || raw === '') {
    return String(process.env.NODE_ENV || '') !== 'production';
  }
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

module.exports = { projectionReadEnabled };
