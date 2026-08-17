// 后台外部 API 主备凭据配置。Token 只在服务端解密使用，接口只返回掩码。
const crypto = require('crypto');
const { SECRET } = require('../config');
const { getConfig, setConfig } = require('../db/config');

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
    lastSwitch: item.lastSwitch || null,
    updatedAt: item.updatedAt || null,
  };
}

async function getExternalApiSettings() {
  const result = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const item = await getProviderRuntime(provider);
    result[provider] = {
      provider: item.provider,
      label: item.label,
      mode: item.mode,
      notify_on_switch: item.notifyOnSwitch,
      primary: { configured: Boolean(item.primary), masked: maskSecret(item.primary) },
      backup: { configured: Boolean(item.backup), masked: maskSecret(item.backup) },
      last_switch: item.lastSwitch,
      updated_at: item.updatedAt,
    };
  }
  return result;
}

async function saveProviderSettings(provider, input = {}) {
  if (!PROVIDERS[provider]) throw new Error('不支持的外部 API');
  const store = await readStore();
  store.providers = store.providers || {};
  const current = store.providers[provider] || {};
  if (typeof input.primary_token === 'string' && input.primary_token.trim()) current.primary = encryptSecret(input.primary_token.trim());
  if (typeof input.backup_token === 'string' && input.backup_token.trim()) current.backup = encryptSecret(input.backup_token.trim());
  if (input.clear_primary === true) delete current.primary;
  if (input.clear_backup === true) delete current.backup;
  if (input.mode !== undefined) current.mode = normalizeMode(input.mode);
  if (input.notify_on_switch !== undefined) current.notifyOnSwitch = Boolean(input.notify_on_switch);
  current.updatedAt = new Date().toISOString();
  store.providers[provider] = current;
  await writeStore(store);
  return getProviderRuntime(provider);
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
  if (provider === 'tushare') {
    const { resetExternalCallGuard, resetExternalCallGuardPersistence } = require('./externalCallGuard');
    resetExternalCallGuard();
    await resetExternalCallGuardPersistence('tushare');
    await resetExternalCallGuardPersistence('tushare_backup');
  }
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
  saveProviderSettings,
  recordProviderSwitch,
  switchProvider,
};
