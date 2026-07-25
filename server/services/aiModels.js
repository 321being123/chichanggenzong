// ========== 大模型后台配置服务 ==========
// 模型列表存 platform_config 表的 ai_models 键（JSON 数组），供管理后台增删改与图片/Excel识别兜底调用共用。
// 调用状态（成功/失败/耗时）存模块级内存，重启清零（单实例可接受，避免为瞬态数据开表）。
const { getConfig, setConfig } = require('../db');

const CONFIG_KEY = 'ai_models';

// id -> { ok, at, ms, error }
const statusMap = new Map();

async function getModels() {
  const raw = await getConfig(CONFIG_KEY, '');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

async function saveModels(list) {
  await setConfig(CONFIG_KEY, JSON.stringify(Array.isArray(list) ? list : []));
}

// 启用中的模型按 order 升序（order 最小者即默认模型）
async function getActiveSorted() {
  const list = await getModels();
  return list
    .filter(function (m) { return m && m.enabled !== false && m.apiKey && m.model; })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

// Key 打码：前4位 + *** + 后4位（过短则只留前2位）
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

function recordStatus(id, ok, error, ms) {
  if (!id) return;
  statusMap.set(id, {
    ok: !!ok,
    at: Date.now(),
    ms: ms || 0,
    error: error ? String(error).slice(0, 200) : ''
  });
}

function getStatus(id) {
  return statusMap.get(id) || null;
}

// 启动初始化：DB 尚无配置且 .env 有 VISION_API_KEY 时，把 .env 现有配置迁移为一条默认模型（平滑过渡）
async function ensureAiModelsInit() {
  try {
    const list = await getModels();
    if (list.length) return;
    if (!process.env.VISION_API_KEY) return;
    await saveModels([{
      id: 'm_' + Date.now(),
      name: '默认模型',
      model: process.env.VISION_MODEL || 'agnes-2.0-flash',
      apiUrl: process.env.VISION_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions',
      apiKey: process.env.VISION_API_KEY,
      enabled: true,
      order: 0
    }]);
    console.log('[aiModels] 已从 .env 初始化默认大模型配置');
  } catch (e) {
    console.error('[aiModels] 初始化大模型配置失败:', e.message);
  }
}

module.exports = { CONFIG_KEY, getModels, saveModels, getActiveSorted, maskKey, recordStatus, getStatus, ensureAiModelsInit };
