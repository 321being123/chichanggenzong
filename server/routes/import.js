// ========== 导入 / 扫码上传 / AI 识别路由 ==========
// 注意：本路由挂载在根路径 '/'，同时承接 /api/* 与 /m/*（手机上传页）
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { assertSafeUrl } = require('../services/ai');
const { visionUploadTokens, TOKEN_TTL, mobileUploadHtml, consumeVisionToken } = require('../services/vision');
const { upsertIndexPoints } = require('../db');
const normalizeCode = require('../../public/js/code-classify.js').normalizeCode;

// 图片校验：仅接受图片 MIME，解码后不超过 10MB；返回错误信息字符串或 null
function validateImage(image) {
  if (!image) return '缺少图片';
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(image);
  if (!m) return '仅支持图片文件';
  const size = Math.floor(m[2].length * 3 / 4);
  if (size > 10 * 1024 * 1024) return '图片过大（上限 10MB）';
  return null;
}

// 限制解析后的表格规模，防止超大表格撑爆内存 / AI token
function trimSheetRows(rows, maxRows, maxCols, maxCell) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, maxRows).map(function (r) {
    const arr = Array.isArray(r) ? r : [];
    return arr.slice(0, maxCols).map(function (c) {
      const s = String(c == null ? '' : c);
      return s.length > maxCell ? s.slice(0, maxCell) : s;
    });
  });
}

// 生成上传token
router.post('/api/vision-token', requireLogin, async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    visionUploadTokens.set(token, { image: null, timestamp: Date.now(), username: req.session.user });
    const url = `${req.protocol}://${req.get('host')}/m/upload/${token}`;
    const qr = await QRCode.toDataURL(url, { width: 160, margin: 1 });
    res.json({ token, qr });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败: ' + e.message });
  }
});

// 手机上传页面
router.get('/m/upload/:token', (req, res) => {
  const { token } = req.params;
  if (!visionUploadTokens.has(token)) {
    return res.status(404).send('<h2 style="text-align:center;padding:40px;color:#d93025;">二维码已过期，请刷新电脑端页面重新生成</h2>');
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(mobileUploadHtml(token));
});

// 手机端上传图片
router.post('/api/vision-upload/:token', (req, res) => {
  const { token } = req.params;
  const { image } = req.body;
  const entry = visionUploadTokens.get(token);
  if (!entry) return res.status(404).json({ ok: false, error: 'token已过期' });
  const imgErr = validateImage(image);
  if (imgErr) return res.status(400).json({ ok: false, error: imgErr });
  entry.image = image;
  entry.timestamp = Date.now();
  res.json({ ok: true });
});

// 电脑端轮询检测
router.get('/api/vision-check/:token', requireLogin, (req, res) => {
  const r = consumeVisionToken(req.params.token, req.session.user);
  if (r.forbidden) return res.status(403).json({ error: '无权访问该上传', expired: false });
  res.json({ image: r.image, expired: r.expired });
});

// ========== AI视觉识别截图（交易/持仓自动识别） ==========
router.post('/api/vision-parse', requireLogin, rateLimit({ prefix: 'ai', windowMs: 60000, max: 10, message: 'AI 识别请求过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const { image, model } = req.body;
    if (!image) return res.status(400).json({ error: '请上传图片' });
    const imgErr = validateImage(image);
    if (imgErr) return res.status(400).json({ error: imgErr });

    const endpoint = process.env.VISION_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
    assertSafeUrl(endpoint);
    const visionModel = model || process.env.VISION_MODEL || 'agnes-1.5-flash';
    const key = process.env.VISION_API_KEY;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图片。如果是交易截图，提取所有交易记录；如果是持仓截图，提取所有持仓记录。请判断每一行是交易还是持仓，返回统一JSON数组。每个元素必须包含 kind 字段：交易为 "trade"，持仓为 "position"。交易字段：code(证券代码，字符串保留前导零)、name(证券名称)、price(成交价格数字)、quantity(成交数量整数)、direction(buy或sell)、date(交易日期YYYY-MM-DD，没有则留空)。持仓字段：code(证券代码，字符串保留前导零)、name(证券名称)、price(成本价或当前价数字)、quantity(持仓数量整数)。格式示例：[{"kind":"trade","code":"000001","name":"平安银行","price":12.34,"quantity":100,"direction":"buy","date":"2026-07-09"},{"kind":"position","code":"000001","name":"平安银行","price":12.34,"quantity":100}]。如果无法识别返回空数组[]。只返回JSON数组，不要任何其他文字。' },
            { type: 'image_url', image_url: { url: image } }
          ]
        }],
        max_tokens: 2000,
        temperature: 0
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ error: 'AI服务返回错误: ' + (response.status + ' ' + errText).substring(0, 200) });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ items: [] });

    const items = JSON.parse(jsonMatch[0]);
    items.forEach(it => { if (it && it.code) it.code = normalizeCode(it.code); });
    res.json({ items: items });
  } catch (e) {
    res.json({ error: '识别失败: ' + e.message });
  }
}));

// ========== Excel 导入解析（大模型，交易/持仓自动识别）==========
router.post('/api/excel-parse', requireLogin, rateLimit({ prefix: 'ai', windowMs: 60000, max: 10, message: 'Excel 解析请求过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const { file, model } = req.body;
    if (!file) return res.status(400).json({ error: '请上传Excel文件' });

    const base64Data = file.split(',')[1] || file;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Excel 文件过大（解压上限 10MB）' });
    let workbook;
    try { workbook = XLSX.read(buffer, { type: 'buffer' }); } catch (e) { return res.status(400).json({ error: 'Excel 解析失败：文件可能已损坏' }); }
    if (workbook.SheetNames.length > 20) return res.status(400).json({ error: 'Excel 工作表过多' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    let rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    rows = trimSheetRows(rows, 2000, 60, 300); // 限行/列/单元格，防撑爆与 AI token 放大

    if (!rows || rows.length === 0) {
      return res.json({ items: [] });
    }

    // AI 输入截断，避免超大表格放大 token 成本（最多约 5 万字符）
    const rowsJson = JSON.stringify(rows);
    const rowsPayload = rowsJson.length > 50000 ? rowsJson.slice(0, 50000) : rowsJson;

    const endpoint = process.env.VISION_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
    assertSafeUrl(endpoint);
    const chatModel = model || process.env.VISION_MODEL || 'agnes-1.5-flash';
    const key = process.env.VISION_API_KEY;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: chatModel,
        messages: [{
          role: 'user',
          content: '以下是从Excel中提取的原始数据（第一行为表头）。请先判断这是交易明细表还是持仓表，然后逐行识别。对每一行，必须返回 kind 字段：交易为 "trade"，持仓为 "position"。交易字段：code(证券代码，必须作为字符串返回并保留前导零，如 000001)、name(证券名称)、price(成交价格数字)、quantity(成交数量整数)、direction(buy或sell)、date(交易日期YYYY-MM-DD，没有则留空)。持仓字段：code(证券代码，必须作为字符串返回并保留前导零)、name(证券名称)、quantity(持仓数量整数，优先取"股票余额/持仓数量/总余额")、price(成本价或买入均价数字；没有成本价则填市价，必须大于0)。格式示例：[{"kind":"trade","code":"000001","name":"平安银行","price":12.34,"quantity":100,"direction":"buy","date":"2026-07-09"},{"kind":"position","code":"000001","name":"平安银行","price":12.34,"quantity":100}]。如果无法识别返回空数组[]。只返回JSON数组，不要任何其他文字。\n\n' + rowsPayload
        }],
        max_tokens: 4000,
        temperature: 0
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ error: 'AI服务返回错误: ' + (response.status + ' ' + errText).substring(0, 200) });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ items: [] });

    const items = JSON.parse(jsonMatch[0]);
    items.forEach(it => { if (it && it.code) it.code = normalizeCode(it.code); });
    res.json({ items: items });
  } catch (e) {
    res.json({ error: '解析失败: ' + e.message });
  }
}));

// ========== 导入历史净值数据（大模型识别，允许缺字段） → 回填 navHistory 历史段 ==========
router.post('/api/excel-history-parse', requireLogin, rateLimit({ prefix: 'ai', windowMs: 60000, max: 10, message: 'Excel 解析请求过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '请上传Excel文件' });
    const base64Data = file.split(',')[1] || file;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Excel 文件过大（解压上限 10MB）' });
    let workbook;
    try { workbook = XLSX.read(buffer, { type: 'buffer' }); } catch (e) { return res.status(400).json({ error: 'Excel 解析失败：文件可能已损坏' }); }
    if (workbook.SheetNames.length > 20) return res.status(400).json({ error: 'Excel 工作表过多' });
    const sheetName = workbook.SheetNames.find(n => n.includes('资金')) || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    if (!rows || rows.length < 2) return res.json({ headers: [], rows: [], total: 0 });
    // 限制规模后返回原始表头与数据行，由前端做"精确匹配/手动匹配"，避免任何猜测导致数据错配或丢行
    const headerCells = (rows[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
    const dataRows = trimSheetRows(rows.slice(1), 2000, 60, 300)
      .filter(function (r) { return r && r.some(function (c) { return c !== '' && c != null; }); });
    res.json({ headers: headerCells, rows: dataRows, total: dataRows.length });
  } catch (e) {
    res.status(400).json({ error: '解析失败: ' + e.message });
  }
}));

// ========== 指数历史点增量写入（前端 syncIndexPoints 调用） ==========
router.post('/api/index-history', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  try {
    const { account, points } = req.body;
    if (!account || !Array.isArray(points)) return res.status(400).json({ error: '无效数据' });
    await upsertIndexPoints(req.session.user, account, points);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: '保存指数历史失败: ' + e.message });
  }
}));

// 暴露 validateImage 供测试使用（不改变 router 导出）
router.validateImage = validateImage;

module.exports = router;
