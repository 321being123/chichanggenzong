const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireAdmin } = require('../middleware/auth');
const svc = require('../services/convertibleBondValuationService');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');

const VALID_RANGES = ['1y', '3y', '5y', 'all'];
const LEVEL_MAP = { attention: '关注', important: '重要', 关注: '关注', 重要: '重要' };

function resolveCode(req) {
  // 允许 113050 或 113050.SH；统一按完整代码处理（库里存的是带后缀的 canonical_code）
  return String(req.params.code || '').trim();
}

// 列表（含筛选、计数、市场概览）
router.get('/bonds', asyncHandler(async (req, res) => {
  const filters = {
    search: req.query.search ? String(req.query.search).trim() : '',
    final_evaluation: req.query.final_evaluation ? String(req.query.final_evaluation).trim() : '',
    safety_level: req.query.safety_level ? String(req.query.safety_level).trim() : '',
    alert_level: req.query.alert_level ? String(req.query.alert_level).trim() : '无',
    data_status: req.query.data_status ? String(req.query.data_status).trim() : '',
  };
  const result = await svc.getList(req.query.date ? String(req.query.date) : null, filters);
  if (!result) return res.json({ as_of_date: null, total: 0, valued_count: 0, counts: {}, data: [], message: '尚未生成估值数据，请先运行估值引擎' });
  res.json(result);
}));

// 单券详情
router.get('/bonds/:code', asyncHandler(async (req, res) => {
  const detail = await svc.getBondDetail(resolveCode(req));
  if (!detail) return res.status(404).json({ error: '未找到该可转债的估值数据（代码不存在或非可转债）' });
  res.json(detail);
}));

// 单券历史估值
router.get('/bonds/:code/history', asyncHandler(async (req, res) => {
  const range = String(req.query.range || 'all');
  if (!VALID_RANGES.includes(range)) return res.status(400).json({ error: '非法的 range 参数，仅支持 1y / 3y / 5y / all' });
  const history = await svc.getHistory(resolveCode(req), range);
  if (!history.length) return res.status(404).json({ error: '该可转债暂无历史估值数据' });
  // 模型版本固化的偏离分位边界（百分比），供前端画固定参考线（不随查看范围变化）
  let boundaries = null;
  try {
    const model = await svc.getActiveModel();
    let q = model && model.residual_quantiles;
    if (typeof q === 'string') q = JSON.parse(q);
    if (q && q.q20 != null) {
      boundaries = {
        q20: Math.round(q.q20 * 10000) / 100,
        q40: Math.round(q.q40 * 10000) / 100,
        q60: Math.round(q.q60 * 10000) / 100,
        q80: Math.round(q.q80 * 10000) / 100,
      };
    }
  } catch (e) { boundaries = null; }
  res.json({ bond_code: resolveCode(req), range, data: history, boundaries });
}));

// 预警列表
router.get('/alerts', asyncHandler(async (req, res) => {
  const filters = {
    level: req.query.level ? (LEVEL_MAP[req.query.level] || String(req.query.level)) : '',
    active: req.query.active === undefined ? undefined : (req.query.active === 'true' || req.query.active === '1'),
    range: req.query.range && VALID_RANGES.includes(String(req.query.range)) ? String(req.query.range) : null,
  };
  const data = await svc.getAlerts(filters);
  res.json({ total: data.length, data });
}));

// 单券预警
router.get('/bonds/:code/alerts', asyncHandler(async (req, res) => {
  const data = await svc.getBondAlerts(resolveCode(req));
  res.json({ bond_code: resolveCode(req), total: data.length, data });
}));

// 管理员刷新（每日推算最新交易日并生成预警）——同步等待，失败返回明确原因
let refreshRunning = false;
router.post('/refresh', requireAdmin, asyncHandler(async (req, res) => {
  if (refreshRunning) return res.status(409).json({ error: '已有估值刷新任务正在运行，请稍后再试' });
  const script = path.join(__dirname, '..', 'scripts', 'convertibleBondValuation.py');
  const py = process.env.VALUATION_PYTHON || path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe');
  refreshRunning = true;
  try {
    const { stdout } = await execFileAsync(py, [script, 'refresh'], {
      cwd: path.join(__dirname, '..', '..'),
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const tail = String(stdout || '').trim().split('\n').slice(-5).join('\n');
    res.json({ ok: true, message: '估值刷新完成', detail: tail });
  } catch (err) {
    const reason = String(err.stderr || err.message || '').trim().split('\n').slice(-5).join('\n');
    console.error('[bond-valuation] 刷新失败:', reason);
    res.status(500).json({ ok: false, error: '估值刷新失败', reason });
  } finally {
    refreshRunning = false;
  }
}));

module.exports = router;
