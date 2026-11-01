// 理杏仁官方开放平台（open.lixinger.com）统一调用入口。
//
// 职责边界：
//   - 只做协议、守卫、原始留证和错误归一；不做业务字段投影，不判断业务是否需要该数据。
//   - 接口白名单来自 dataAccess/lixingerCatalog（官方文档生成），这里不写任何接口路径。
//   - 所有真实请求都经过 services/externalCallGuard：预算/限流计入真实调用，
//     429 与 5xx 的重试同样计入，不允许绕过 Guard 直连上游。
//
// 额度口径：官方限制按账号（同一 token 跨接口共享），因此预算按接口名 '*' 记账；
// 熔断按单接口作用域（source='lixinger_official:<接口名>'），
// 单接口 429/403 不会熔断整个来源或其他接口。
const crypto = require('crypto');
const { tokenFingerprint, withExternalCallGuard, openExternalCircuit } = require('./externalCallGuard');
const { recordEndpointPermission } = require('./sourceEndpointPolicy');
const { apiNameOf, buildRequestBody, endpointUrl, getEndpoint } = require('../dataAccess/lixingerCatalog');
const repository = require('../repositories/lixingerOfficialRepository');

const SOURCE = 'lixinger_official';
// 官方 skill 文档：网络超时与 5xx 最多重试 5 次，间隔依次为 1/2/4/8/16 秒；
// 429 等待 1 秒后只重试一次，仍失败则按真实限流开启接口熔断。
const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
const RATE_LIMIT_DELAY_MS = 1000;
// 官方 skill 1.0.43 要求带 Chrome UA 与完整 gzip 声明，缺省会返回非 JSON 的 400 提示。
const REQUEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const RETRYABLE_CODES = new Set(['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'UPSTREAM_5XX']);
const PERMISSION_CACHE_MS = 60000;

const permissionCache = new Map();
const inFlight = new Map();

function sourceError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, source: SOURCE, retryable: RETRYABLE_CODES.has(code) }, details);
}

function readToken() {
  const token = String(process.env.LIXINGER_TOKEN || '').trim();
  if (!token) throw sourceError('NOT_CONFIGURED', '理杏仁官方接口尚未配置 LIXINGER_TOKEN');
  return token;
}

function redact(text, token) {
  const value = String(text == null ? '' : text);
  return token ? value.split(token).join('***') : value;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sleepDefault(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

// 官方响应信封：成功 {code:1,message:'success',total?,data:[...]}；
// 失败 {code:0,error:{name,message}}。判定只看是否带 error 字段与 data 是否数组，
// 不沿用 GeoScope 时代按 code 猜成功的写法。
function unwrapPayload(payload, endpoint) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw sourceError('INVALID_RESPONSE', `理杏仁 ${endpoint.key} 响应格式异常，保留旧数据`);
  }
  if (payload.error) {
    const name = payload.error.name || payload.error.code || 'UpstreamError';
    const message = payload.error.message || '上游返回业务错误';
    throw sourceError('UPSTREAM_ERROR', `理杏仁 ${endpoint.key} 返回业务错误（${name}）：${message}`, { upstreamName: name });
  }
  if (payload.code !== 1 || !Array.isArray(payload.data)) {
    throw sourceError('INVALID_RESPONSE', `理杏仁 ${endpoint.key} 响应缺少 data 数组，保留旧数据`);
  }
  return { rows: payload.data, total: payload.total == null ? null : Number(payload.total) };
}

function mapHttpFailure(status, body, endpoint, token) {
  const upstream = body && typeof body === 'object' ? body : {};
  const name = upstream.error && (upstream.error.name || upstream.error.code) || null;
  const upstreamMessage = upstream.error && upstream.error.message || upstream.message || '';
  const detail = redact(`理杏仁 ${endpoint.key} 请求失败（HTTP ${status}）${name ? `；name=${name}` : ''}${upstreamMessage ? `；message=${upstreamMessage}` : ''}`, token);
  if (status === 401) return sourceError('INVALID_CREDENTIAL', detail, { status });
  // 官方 skill 1.0.43 口径：403 表示会员过期或当前接口免费次数已用完，
  // 因此按"当前接口暂时不可用"处理：留证 + 单接口熔断到次日探测，不扩大到整个来源。
  if (status === 403) return sourceError('ACCESS_FORBIDDEN', detail, { status });
  if (status === 429) return sourceError('RATE_LIMIT', detail, { status });
  if (status === 404) return sourceError('ENDPOINT_NOT_ADMITTED', detail, { status });
  if (status >= 500) return sourceError('UPSTREAM_5XX', detail, { status });
  return sourceError('INVALID_REQUEST', detail, { status });
}

async function assertEndpointPermitted({ endpoint, apiName, fingerprint, client }) {
  const cacheKey = `${apiName}:${fingerprint}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.blocked) throw sourceError(cached.code, cached.message, { apiName });
    return;
  }
  const { rows } = await repository.selectPolicy({ sourceCode: SOURCE, apiName, credentialProfile: 'primary' }, client);
  const policy = rows[0];
  let blocked = false;
  let code = '';
  let message = '';
  if (policy && String(policy.credential_fingerprint || 'none') === fingerprint
    && ['permission_denied', 'not_configured'].includes(String(policy.permission_status || ''))) {
    blocked = true;
    code = policy.permission_status === 'permission_denied' ? 'PERMISSION_DENIED' : 'ENDPOINT_DISABLED';
    message = `理杏仁接口 ${apiName} 已记录为${policy.permission_status === 'permission_denied' ? '无权限' : '未配置'}，按策略停止调用`;
  }
  permissionCache.set(cacheKey, { blocked, code, message, expiresAt: Date.now() + PERMISSION_CACHE_MS });
  if (blocked) throw sourceError(code, message, { apiName });
}

// 单个 HTTP 请求（一次真实上游调用）。
// 截止时间必须同时覆盖「等响应头」和「读响应体」：官方大响应体先回头再慢慢传，
// 只在 fetch 上计时会让读体无限挂起（2026-11-01 审查 R2-005）。因此 timer 在整个
// 请求—读体—解析期间有效，读到结果或失败后才清理。
// 外部取消（父任务止损/进程停机）通过 signal 组合进来：取消不重试，deadline 到期按超时分类。
async function requestOnce({ endpoint, body, token, timeoutMs, fetcher, signal }) {
  const controller = new AbortController();
  // 下限只保留 1ms：父任务只剩几十毫秒时，这里若放大到 1 秒，请求会越过父截止继续跑（验收 V-03）。
  const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 30000, 1));
  const cancelled = () => Boolean(signal && signal.aborted);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw sourceError('CANCELLED', `理杏仁 ${endpoint.key} 请求已被调用方取消`);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    let response;
    try {
      response = await fetcher(endpointUrl(endpoint), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          // 官方接口强制要求声明 gzip，否则直接返回非 JSON 的 400 提示。
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': REQUEST_UA,
        },
        body: JSON.stringify({ ...body, token }),
      });
    } catch (error) {
      if (controller.signal.aborted || cancelled()) {
        throw cancelled()
          ? sourceError('CANCELLED', `理杏仁 ${endpoint.key} 请求已被调用方取消`)
          : sourceError('NETWORK_TIMEOUT', `理杏仁 ${endpoint.key} 请求超时`);
      }
      throw sourceError('NETWORK_ERROR', redact(`理杏仁 ${endpoint.key} 网络请求失败：${error && error.message}`, token));
    }

    // 读体仍在同一截止时间内，失败必须保留超时/断流分类，不能吞成空字符串
    // （否则上层会把"读体失败"当成"成功空结果"，进而推进覆盖水位）。
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (cancelled()) throw sourceError('CANCELLED', `理杏仁 ${endpoint.key} 请求已被调用方取消`);
      if (controller.signal.aborted) throw sourceError('NETWORK_TIMEOUT', `理杏仁 ${endpoint.key} 读取响应体超时`);
      throw sourceError('NETWORK_ERROR', redact(`理杏仁 ${endpoint.key} 读取响应体失败：${error && error.message}`, token));
    }

    let payload = null;
    if (text) {
      // JSON.parse 是同步调用，不会被事件循环里的定时器抢占；
      // 这里只保证读体受截止时间约束，不宣称解析阶段有硬中断。
      try {
        payload = JSON.parse(text);
      } catch (_) {
        if (response.ok) throw sourceError('INVALID_RESPONSE', `理杏仁 ${endpoint.key} 响应不是有效 JSON，保留旧数据`);
      }
    }
    if (!response.ok) throw mapHttpFailure(response.status, payload, endpoint, token);
    return payload;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用一个已准入的官方接口。
 * @param {string} endpointKey 目录键，例如 'cn/company'
 * @param {object} params 文档声明的参数（不含 token）
 * @param {object} options
 *   - dataset: 数据集代码（原始记录与告警作用域），默认按接口
 *   - targetDate: 任务目标业务日，用于同数据集并发锁
 *   - maxAgeMs: 命中已落库原始响应的有效期；默认 0（不复用，必须真实请求）
 *   - fetch/sleep/client: 测试注入
 * @returns {Promise<{rows:object[],total:number|null,rawRecordId:number|null,payloadHash:string|null,cached:boolean,empty:boolean,endpoint:string,apiName:string}>}
 */
async function callEndpoint(endpointKey, params = {}, options = {}) {
  const endpoint = getEndpoint(endpointKey);
  const body = buildRequestBody(endpoint, params);
  const apiName = apiNameOf(endpoint);
  const token = readToken();
  const fingerprint = tokenFingerprint(token);
  const requestKey = `${endpoint.key}#${sha256(JSON.stringify(stableJson(body)))}`;
  const dataset = String(options.dataset || endpoint.key);
  const fetcher = options.fetch || fetch;
  const sleep = options.sleep || sleepDefault;
  const maxAgeMs = Number(options.maxAgeMs || 0);
  const circuitSource = `${SOURCE}:${apiName}`;
  const guardOptions = { apiName: '*', credentialProfile: 'primary', tokenFingerprint: fingerprint, circuitSource };

  await assertEndpointPermitted({ endpoint, apiName, fingerprint, client: options.client });

  if (maxAgeMs > 0) {
    const recent = await repository.findRecentResponse(
      { sourceCode: SOURCE, requestKey, ttlMs: maxAgeMs }, options.client
    );
    if (recent.rows[0]) {
      const cached = unwrapPayload(recent.rows[0].payload, endpoint);
      return {
        rows: cached.rows, total: cached.total, rawRecordId: recent.rows[0].raw_record_id,
        payloadHash: recent.rows[0].payload_hash, cached: true, empty: cached.rows.length === 0,
        endpoint: endpoint.key, apiName,
      };
    }
  }

  if (inFlight.has(requestKey)) return inFlight.get(requestKey);
  const task = runWithRetry({ endpoint, body, token, fingerprint, apiName, dataset, requestKey, circuitSource, guardOptions, fetcher, sleep, options });
  inFlight.set(requestKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(requestKey);
  }
}

async function runWithRetry(ctx) {
  const { endpoint, body, token, fingerprint, apiName, dataset, requestKey, circuitSource, guardOptions, fetcher, sleep, options } = ctx;
  let retryIndex = 0;
  let rateLimitTried = false;
  // 每次尝试都独立走 Guard：重试也是真实上游调用，必须计入预算和限流。
  for (;;) {
    try {
      return await withExternalCallGuard(SOURCE, dataset, options.targetDate || null, async (client, guard) => {
        const policyTimeoutMs = guard && guard.timeoutMs ? Number(guard.timeoutMs) : 30000;
        // 单次 HTTP 超时 = min(接口策略, 调用方要求, 父任务剩余时间)。
        // 任何一项都不能被其它项放大：剩余 40ms 就必须按 40ms 计时（验收 V-03）。
        const deadlineAt = Number(options.deadlineAt) || 0;
        const remainingMs = deadlineAt ? deadlineAt - Date.now() : Infinity;
        if (remainingMs <= 0) {
          throw sourceError('DEADLINE_EXCEEDED', `理杏仁 ${endpoint.key} 未在父任务截止时间内完成，剩余范围留待续跑`);
        }
        const callerTimeoutMs = options.timeoutMs ? Math.max(Number(options.timeoutMs) || 0, 1) : Infinity;
        const timeoutMs = Math.min(policyTimeoutMs, callerTimeoutMs, remainingMs);
        const payload = await requestOnce({ endpoint, body, token, timeoutMs, fetcher, signal: options.signal });
        // 请求即使成功，只要父截止已过就不能留下"成功原始记录"，否则会伪造一次按时完成。
        if (deadlineAt && Date.now() >= deadlineAt) {
          throw sourceError('DEADLINE_EXCEEDED', `理杏仁 ${endpoint.key} 在父任务截止后才返回，结果不落库、留待续跑`);
        }
        const parsed = unwrapPayload(payload, endpoint);
        const payloadJson = JSON.stringify(payload);
        const payloadHash = sha256(payloadJson);
        const saved = await repository.saveResponse({ sourceCode: SOURCE, requestKey, payloadJson, payloadHash }, client);
        const rawRecordId = saved.rows[0] ? saved.rows[0].raw_record_id : null;
        await recordEndpointPermission(SOURCE, 'primary', apiName, fingerprint, {
          status: parsed.rows.length ? 'available' : 'empty_but_accepted',
          message: parsed.rows.length ? '官方接口采集成功，原始响应已落库' : '官方接口成功空结果，不推进覆盖水位',
        }).catch(() => {});
        return {
          rows: parsed.rows, total: parsed.total, rawRecordId, payloadHash,
          cached: false, empty: parsed.rows.length === 0, endpoint: endpoint.key, apiName,
        };
      }, guardOptions);
    } catch (error) {
      const code = error && error.code;
      if (code === 'INVALID_CREDENTIAL') {
        // 401 是凭据问题，不是接口问题：记录凭据级证据后停止，不重试、不绕过。
        await recordEndpointPermission(SOURCE, 'primary', apiName, fingerprint, { status: 'not_configured', message: error.message }).catch(() => {});
        throw error;
      }
      if (code === 'ACCESS_FORBIDDEN') {
        // 403 按官方口径可能是会员到期或该接口免费次数用完：留证并按接口熔断到次日自动探测，
        // 不永久停用策略（避免把临时额度问题写成永久无权限），也不扩大到整个来源。
        await recordEndpointPermission(SOURCE, 'primary', apiName, fingerprint, { status: 'error', message: error.message }).catch(() => {});
        await openExternalCircuit(circuitSource, error.message, { ...guardOptions, errorCode: 'QUOTA_EXHAUSTED' }).catch(() => {});
        throw error;
      }
      if (code === 'RATE_LIMIT') {
        if (!rateLimitTried) {
          rateLimitTried = true;
          // 429 的等待也是父任务时间的一部分：剩余时间不够就别再等。
          if (options.deadlineAt && Number(options.deadlineAt) - Date.now() <= RATE_LIMIT_DELAY_MS) {
            throw sourceError('DEADLINE_EXCEEDED', `理杏仁 ${endpoint.key} 剩余时间不足以等待限流重试，剩余范围留待续跑`);
          }
          await sleep(RATE_LIMIT_DELAY_MS);
          continue;
        }
        await openExternalCircuit(circuitSource, error.message, { ...guardOptions, errorCode: 'RATE_LIMIT' }).catch(() => {});
        throw error;
      }
      if (!RETRYABLE_CODES.has(code) || retryIndex >= RETRY_DELAYS_MS.length) throw error;
      // 重试前的等待也不得突破父任务剩余时间：剩余不足以完成这次退避时直接交回上层续跑。
      if (options.deadlineAt) {
        const remaining = Number(options.deadlineAt) - Date.now();
        if (remaining <= RETRY_DELAYS_MS[retryIndex]) {
          throw sourceError('DEADLINE_EXCEEDED', `理杏仁 ${endpoint.key} 剩余时间不足以重试，剩余范围留待续跑`);
        }
      }
      await sleep(RETRY_DELAYS_MS[retryIndex]);
      retryIndex += 1;
    }
  }
}

module.exports = {
  SOURCE,
  RETRY_DELAYS_MS,
  callEndpoint,
  unwrapPayload,
};
