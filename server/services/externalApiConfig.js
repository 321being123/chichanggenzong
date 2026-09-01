// 后台外部 API 主备凭据配置。Token 只在服务端解密使用，接口只返回掩码。
const crypto = require('crypto');
const https = require('https');
const { SECRET } = require('../config');
const { getConfig, setConfig } = require('../db/config');
const { withExternalCallGuard, tokenFingerprint } = require('./externalCallGuard');

const CONFIG_KEY = 'external_api_configs';
const PROVIDERS = {
  tushare: {
    label: 'Tushare Pro',
    env: { primary: 'TUSHARE_TOKEN', backup: 'TUSHARE_BACKUP_TOKEN' },
  },
};

function normalizeMode(value) {
  return ['auto', 'primary', 'backup'].includes(String(value || '')) ? String(value) : 'auto';
}

function encryptionKey() {
  const seed = process.env.EXTERNAL_API_CONFIG_KEY || SECRET || '';
  return crypto.createHash('sha256').update(`external-api-config:${seed}`).digest();
}

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!text.startsWith('enc:v1:')) return text;
  const [, , ivHex, tagHex, dataHex] = text.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (error) {
    return '';
  }
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function normalizeTestRole(value) {
  return ['primary', 'backup', 'current'].includes(String(value || '')) ? String(value) : 'current';
}

const TUSHARE_TEST_PROBES = {
  trade_cal: { params: { exchange: 'SSE', start_date: '20200102', end_date: '20200102' }, fields: 'cal_date,is_open' },
  stock_basic: { params: { ts_code: '000001.SZ' }, fields: 'ts_code,name,list_status' },
  daily: { params: { ts_code: '000001.SZ', start_date: '20200102', end_date: '20200103' }, fields: 'ts_code,trade_date,close' },
  daily_basic: { params: { ts_code: '000001.SZ', trade_date: '20200102' }, fields: 'ts_code,trade_date,pb,total_mv' },
  adj_factor: { params: { ts_code: '000001.SZ', start_date: '20200102', end_date: '20200103' }, fields: 'ts_code,trade_date,adj_factor' },
  income: { params: { ts_code: '000001.SZ', period: '20191231' }, fields: 'ts_code,ann_date,end_date,total_revenue,n_income_attr_p' },
  income_vip: { params: { period: '20191231' }, fields: 'ts_code,ann_date,end_date,total_revenue,n_income_attr_p' },
  balancesheet: { params: { ts_code: '000001.SZ', period: '20191231' }, fields: 'ts_code,ann_date,end_date,total_assets,total_liab' },
  balancesheet_vip: { params: { period: '20191231' }, fields: 'ts_code,ann_date,end_date,total_assets,total_liab' },
  cashflow: { params: { ts_code: '000001.SZ', period: '20191231' }, fields: 'ts_code,ann_date,end_date,n_cashflow_act' },
  cashflow_vip: { params: { period: '20191231' }, fields: 'ts_code,ann_date,end_date,n_cashflow_act' },
  fina_indicator: { params: { ts_code: '000001.SZ', period: '20191231' }, fields: 'ts_code,ann_date,end_date,roe,roa' },
  fina_indicator_vip: { params: { period: '20191231' }, fields: 'ts_code,ann_date,end_date,roe,roa' },
  forecast: { params: { ts_code: '000001.SZ', period: '20201231' }, fields: 'ts_code,ann_date,end_date,type' },
  dividend: { params: { ts_code: '000001.SZ' }, fields: 'ts_code,ann_date,end_date,div_proc' },
  rt_min: { params: { ts_code: '000001.SZ', freq: '1MIN' }, fields: 'ts_code,time,close' },
  new_share: { params: { start_date: '20200101', end_date: '20200102' }, fields: 'ts_code,name,ipo_date' },
  cb_basic: { params: { ts_code: '110000.SH' }, fields: 'ts_code,bond_short_name,stk_code' },
  cb_daily: { params: { ts_code: '110000.SH', start_date: '20200102', end_date: '20200102' }, fields: 'ts_code,trade_date,close' },
  cb_issue: { params: { ts_code: '110000.SH' }, fields: 'ts_code,ann_date,issue_size' },
  cb_price_chg: { params: { ts_code: '110000.SH' }, fields: 'ts_code,change_date,convert_price_before,convert_price_after' },
  index_daily: { params: { ts_code: '000300.SH', start_date: '20200102', end_date: '20200102' }, fields: 'ts_code,trade_date,close' },
  index_member_all: { params: { ts_code: '000300.SH' }, fields: 'index_code,con_code,in_date' },
  top10_cb_holders: { params: { ts_code: '110000.SH', end_date: '20200102' }, fields: 'ts_code,end_date,holder_rank,holder_name,hold_amount,hold_ratio' },
  pledge_stat: { params: { ts_code: '000001.SZ', end_date: '20200102' }, fields: 'ts_code,end_date,pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio' },
};

function normalizeTestApi(value) {
  const name = String(value || 'trade_cal').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TUSHARE_TEST_PROBES, name) ? name : 'trade_cal';
}

function safeTestMessage(message, token) {
  let text = String(message || 'API 测试失败').replace(/\s+/g, ' ').trim();
  if (token) text = text.split(String(token)).join('***');
  return text.slice(0, 240);
}

function probeStatus(error) {
  const code = String(error && error.code || '').toUpperCase();
  if (code === 'PERMISSION_DENIED') return 'permission_denied';
  if (code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' || code === 'BUDGET_WAIT' || code === 'CIRCUIT_OPEN') return 'rate_limited';
  if (code === 'EMPTY_DATA') return 'empty_but_accepted';
  return 'error';
}

function normalizeReturnedData(data) {
  if (!data || typeof data !== 'object') return null;
  const fields = Array.isArray(data.fields) ? data.fields.slice(0, 20).map(value => String(value).slice(0, 64)) : [];
  const sourceItems = Array.isArray(data.items) ? data.items : [];
  const items = sourceItems.slice(0, 5).map(row => {
    const values = Array.isArray(row) ? row : [];
    return fields.map((field, index) => {
      const value = values[index];
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value == null ? null : value;
      return String(value).slice(0, 120);
    });
  });
  return { fields, items, truncated: sourceItems.length > items.length };
}

function readTushareHealth(token, apiName = 'trade_cal') {
  const probeName = normalizeTestApi(apiName);
  const probe = TUSHARE_TEST_PROBES[probeName];
  const body = JSON.stringify({
    api_name: probeName,
    token,
    params: probe.params,
    fields: probe.fields,
  });
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const request = https.request('https://api.tushare.pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        let payload;
        try { payload = JSON.parse(responseBody); } catch (error) {
          return reject(new Error(`Tushare 返回了无法解析的响应（HTTP ${response.statusCode || '未知'}）`));
        }
        if (response.statusCode !== 200 || !payload || payload.code !== 0) {
          const upstreamCode = payload && payload.code != null ? `（代码 ${payload.code}）` : '';
          const error = new Error(`${payload && (payload.msg || payload.message) || `HTTP ${response.statusCode || '未知'}`}${upstreamCode}`);
          error.code = response.statusCode === 401 || /token\s*(无效|错误)|invalid token|无效 token/i.test(error.message)
            ? 'AUTH_ERROR' : response.statusCode === 403 || /权限|permission|积分不足|没有接口|无权限/i.test(error.message)
              ? 'PERMISSION_DENIED' : /当日|每日|次数.*耗尽|额度.*耗尽|配额.*耗尽/i.test(error.message)
                ? 'QUOTA_EXHAUSTED' : /429|频率|频次|限速|配额|rate.?limit|quota/i.test(error.message)
                  ? 'RATE_LIMIT' : 'UPSTREAM_ERROR';
          error.apiName = probeName;
          return reject(error);
        }
        const data = payload.data;
        if (data && (!Array.isArray(data.fields) || !Array.isArray(data.items))) {
          return reject(new Error('Tushare 返回的数据结构无效'));
        }
        resolve({
          latency_ms: Date.now() - startedAt,
          data_count: data && Array.isArray(data.items) ? data.items.length : 0,
          returned_data: normalizeReturnedData(data),
          api_name: probeName,
        });
      });
    });
    request.on('error', error => reject(new Error(error.message || '网络连接失败')));
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('请求超时（10 秒）'));
    });
    request.write(body);
    request.end();
  });
}

function normalizeStoredTestResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    status: String(result.status || (result.ok === true ? 'available' : 'unavailable')).slice(0, 32),
    message: String(result.message || '').slice(0, 240),
    latency_ms: Number.isFinite(Number(result.latency_ms)) ? Number(result.latency_ms) : null,
    data_count: Number.isFinite(Number(result.data_count)) ? Number(result.data_count) : null,
    checked_at: result.checked_at || null,
    api_name: String(result.api_name || '').slice(0, 64),
    returned_data: normalizeReturnedData(result.returned_data),
  };
}

async function recordProviderTestResult(provider, role, apiName, result) {
  const store = await readStore();
  store.providers = store.providers || {};
  const current = store.providers[provider] || {};
  current.testResults = current.testResults || {};
  const key = `${role}:${normalizeTestApi(apiName || result && result.api_name)}`;
  current.testResults[key] = normalizeStoredTestResult(result);
  store.providers[provider] = current;
  await writeStore(store);
  return current.testResults[key];
}

async function readStore() {
  const raw = await getConfig(CONFIG_KEY, '');
  if (!raw) return { providers: {} };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { providers: {} };
  } catch (error) {
    return { providers: {} };
  }
}

async function writeStore(store) {
  await setConfig(CONFIG_KEY, JSON.stringify(store || { providers: {} }));
}

function envSecret(provider, slot) {
  const key = PROVIDERS[provider]?.env?.[slot];
  return key ? process.env[key] || '' : '';
}

async function getProviderRuntime(provider = 'tushare') {
  const store = await readStore();
  const item = store.providers && store.providers[provider] || {};
  const primary = decryptSecret(item.primary) || envSecret(provider, 'primary');
  const backup = decryptSecret(item.backup) || envSecret(provider, 'backup');
  return {
    provider,
    label: PROVIDERS[provider]?.label || provider,
    primary,
    backup,
    mode: normalizeMode(item.mode),
    notifyOnSwitch: item.notifyOnSwitch !== false,
    lastSwitch: item.lastSwitch && item.lastSwitch.automatic === false ? item.lastSwitch : null,
    updatedAt: item.updatedAt || null,
    testResults: item.testResults || {},
  };
}

async function testProviderAvailability(provider = 'tushare', role = 'current', apiName = 'trade_cal') {
  if (!PROVIDERS[provider]) throw new Error('不支持的外部 API');
  const runtime = await getProviderRuntime(provider);
  const requestedRole = normalizeTestRole(role);
  const requestedApi = provider === 'tushare' ? normalizeTestApi(apiName) : '';
  const targetRole = requestedRole === 'current'
    ? (runtime.mode === 'backup' ? 'backup' : 'primary')
    : requestedRole;
  const token = runtime[targetRole];
  const checkedAt = new Date().toISOString();
  let result;
  if (!token) {
    result = {
      ok: false,
      status: 'not_configured',
      provider,
      role: targetRole,
      message: `${targetRole === 'primary' ? '主' : '备用'} Token 尚未配置`,
      latency_ms: null,
      data_count: null,
      checked_at: checkedAt,
      api_name: requestedApi,
    };
  } else if (provider === 'tushare') {
    try {
      // 权限探测也是一次真实上游调用，必须经过与业务请求相同的预算、
      // 熔断和数据集锁；否则管理员点一次测试就能绕过限速。
      const guardSource = targetRole === 'backup' ? 'tushare_backup' : 'tushare';
      const health = await withExternalCallGuard(
        guardSource,
        `permission_probe:${requestedApi}`,
        null,
        () => readTushareHealth(token, requestedApi),
        { circuitSource: guardSource, apiName: requestedApi, tokenFingerprint: tokenFingerprint(token) }
      );
      result = {
        ok: true,
        status: health.data_count === 0 ? 'empty_but_accepted' : 'available',
        provider,
        role: targetRole,
        message: '连接成功，Token 可用',
        ...health,
        checked_at: checkedAt,
        api_name: requestedApi,
      };
    } catch (error) {
      result = {
        ok: false,
        status: probeStatus(error),
        provider,
        role: targetRole,
        message: safeTestMessage(error.message || error, token),
        latency_ms: Date.now() - Date.parse(checkedAt),
        data_count: null,
        checked_at: checkedAt,
        api_name: requestedApi,
      };
    }
  } else {
    result = {
      ok: false,
      status: 'unsupported',
      provider,
      role: targetRole,
      message: '该 API 暂未配置可用性测试',
      latency_ms: null,
      data_count: null,
      checked_at: checkedAt,
      api_name: '',
    };
  }
  await recordProviderTestResult(provider, targetRole, requestedApi, result);
  return result;
}

async function getExternalApiSettings() {
  const result = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const item = await getProviderRuntime(provider);
    const { getExternalCircuitStatuses } = require('./externalCallGuard');
    result[provider] = {
      provider: item.provider,
      label: item.label,
      mode: item.mode,
      notify_on_switch: item.notifyOnSwitch,
      primary: { configured: Boolean(item.primary), masked: maskSecret(item.primary) },
      backup: { configured: Boolean(item.backup), masked: maskSecret(item.backup) },
      last_switch: item.lastSwitch,
      updated_at: item.updatedAt,
      test_results: Object.keys(item.testResults || {}).reduce((acc, role) => {
        const safe = normalizeStoredTestResult(item.testResults[role]);
        if (safe) acc[role] = safe;
        return acc;
      }, {}),
      circuits: await getExternalCircuitStatuses(provider, { primary: item.primary, backup: item.backup }),
    };
  }
  return result;
}

async function saveProviderSettings(provider, input = {}) {
  if (!PROVIDERS[provider]) throw new Error('不支持的外部 API');
  const store = await readStore();
  store.providers = store.providers || {};
  const current = store.providers[provider] || {};
  const previousPrimary = decryptSecret(current.primary) || envSecret(provider, 'primary');
  const previousBackup = decryptSecret(current.backup) || envSecret(provider, 'backup');
  const primaryChanged = (typeof input.primary_token === 'string' && input.primary_token.trim()) || input.clear_primary === true;
  const backupChanged = (typeof input.backup_token === 'string' && input.backup_token.trim()) || input.clear_backup === true;
  if (typeof input.primary_token === 'string' && input.primary_token.trim()) current.primary = encryptSecret(input.primary_token.trim());
  if (typeof input.backup_token === 'string' && input.backup_token.trim()) current.backup = encryptSecret(input.backup_token.trim());
  if (input.clear_primary === true) delete current.primary;
  if (input.clear_backup === true) delete current.backup;
  if (input.mode !== undefined) current.mode = normalizeMode(input.mode);
  if (input.notify_on_switch !== undefined) current.notifyOnSwitch = Boolean(input.notify_on_switch);
  current.updatedAt = new Date().toISOString();
  store.providers[provider] = current;
  await writeStore(store);
  if (provider === 'tushare' && (primaryChanged || backupChanged)) {
    const { invalidateExternalCircuits, tokenFingerprint } = require('./externalCallGuard');
    if (primaryChanged && previousPrimary) await invalidateExternalCircuits(provider, tokenFingerprint(previousPrimary));
    if (backupChanged && previousBackup) await invalidateExternalCircuits(`${provider}_backup`, tokenFingerprint(previousBackup));
  }
  return getProviderRuntime(provider);
}

async function notifyTushareFailover(apiName, fromRole, toRole, reason, recoverAt = null) {
  const runtime = await getProviderRuntime('tushare');
  if (runtime.notifyOnSwitch === false) return;
  const recovery = recoverAt ? new Date(recoverAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : 'Token 配置变化后再测';
  const api = String(apiName || '未知接口').slice(0, 64);
  const from = fromRole === 'primary' ? '主Token' : '备用Token';
  const to = toRole === 'primary' ? '主Token' : '备用Token';
  try {
    const { sendAlert } = require('./jobAlertMailer');
    await sendAlert({
      alertKey: `external-api:tushare:${fromRole}:${api}`,
      alertType: 'external_api_interface_failover',
      severity: 'warning',
      jobCode: 'external_api:tushare',
      subject: `${api}：${from} → ${to}`,
      summary: `${api}：${from} → ${to}\n原因：${String(reason || '接口不可用').slice(0, 240)}\n预计恢复：${recovery}\n其他 Tushare 接口继续按各自熔断状态路由。`,
    });
  } catch (_) {
    // 告警失败不影响接口路由。
  }
}

async function recordProviderSwitch(provider, mode, reason = '', options = {}) {
  const targetMode = normalizeMode(mode) === 'primary' ? 'primary' : 'backup';
  const store = await readStore();
  store.providers = store.providers || {};
  const current = store.providers[provider] || {};
  const previous = current.lastSwitch && current.lastSwitch.mode;
  if (!options.force && previous === targetMode) return false;
  current.lastSwitch = {
    mode: targetMode,
    reason: String(reason || '').slice(0, 240),
    automatic: options.automatic !== false,
    switched_at: new Date().toISOString(),
  };
  store.providers[provider] = current;
  await writeStore(store);
  if (current.notifyOnSwitch !== false && options.notify !== false) {
    try {
      const { sendAlert } = require('./jobAlertMailer');
      await sendAlert({
        alertKey: `external-api:${provider}:switch`,
        alertType: 'external_api_switch',
        severity: 'warning',
        jobCode: `external_api:${provider}`,
        subject: `${PROVIDERS[provider]?.label || provider} 已切换到${targetMode === 'primary' ? '主 Token' : '备用 Token'}`,
        summary: `切换原因：${String(reason || '后台手动切换').slice(0, 240)}`,
      }, { manual: options.manual === true });
    } catch (error) {
      // 通知失败不影响主备切换结果。
    }
  }
  return true;
}

async function switchProvider(provider, mode, options = {}) {
  const target = normalizeMode(mode);
  await saveProviderSettings(provider, { mode: target });
  if (target !== 'auto') await recordProviderSwitch(provider, target, options.reason || '后台手动切换', { manual: true, automatic: false, force: true });
  return getProviderRuntime(provider);
}

module.exports = {
  CONFIG_KEY,
  PROVIDERS,
  encryptSecret,
  decryptSecret,
  maskSecret,
  getProviderRuntime,
  getExternalApiSettings,
  testProviderAvailability,
  recordProviderTestResult,
  notifyTushareFailover,
  saveProviderSettings,
  recordProviderSwitch,
  switchProvider,
};
