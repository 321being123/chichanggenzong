// 知识导入 HTTP 取数适配：undici 请求与限流读取的唯一外采落点。
const undici = require('undici');

function safeClose(body) {
  if (!body) return;
  try { if (body.getReader) body.getReader().cancel(); else if (body.destroy) body.destroy(); }
  catch (e) {}
}

// 发起请求并流式读取响应体，超出 maxBytes 或类型不符时提前终止。
// 返回 { ok, status, text() }；网络异常归一为 ok:false。
async function requestWithLimits(url, { dispatcher, signal, headers, method, maxBytes = 5 * 1024 * 1024, allowedTypes = null } = {}) {
  try {
    const requestOptions = { signal };
    if (headers) requestOptions.headers = headers;
    if (method) requestOptions.method = method;
    if (dispatcher) requestOptions.dispatcher = dispatcher;
    const r = await undici.request(url, requestOptions);
    const statusCode = r.statusCode;
    const respHeaders = r.headers || {};
    const ct = (typeof respHeaders['content-type'] === 'string' ? respHeaders['content-type'] : (respHeaders['Content-Type'] || '')).toLowerCase();
    const len = parseInt(respHeaders['content-length'] || '0', 10);
    if (len > maxBytes) { safeClose(r.body); return { ok: false, status: 413, text: () => Promise.resolve('') }; }
    if (allowedTypes && allowedTypes.length && !allowedTypes.some(t => ct.startsWith(t))) {
      safeClose(r.body); return { ok: false, status: 415, text: () => Promise.resolve('') };
    }
    const chunks = [];
    let received = 0;
    const body = r.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        chunks.push(Buffer.from(value));
        if (received > maxBytes) { try { reader.cancel(); } catch (e) {} return { ok: false, status: 413, text: () => Promise.resolve('') }; }
      }
    } else if (body) {
      for await (const chunk of body) {
        received += chunk.length;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (received > maxBytes) { try { body.destroy(); } catch (e) {} return { ok: false, status: 413, text: () => Promise.resolve('') }; }
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { ok: statusCode >= 200 && statusCode < 300, status: statusCode, text: () => Promise.resolve(text) };
  } catch (e) {
    return { ok: false, status: 0, statusText: 'fetch error', text: () => Promise.resolve(String((e && e.message) || '')) };
  }
}

module.exports = { requestWithLimits };
