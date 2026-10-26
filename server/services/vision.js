// ========== 手机扫码上传（in-memory token store + 页面模板） ==========
// 方案《智能导入识别质量与批量录入整改方案_20261026》4.6：
// 手机整批多图原子交付（images）、容量限额、TTL 从生成起算（不靠重复上传续命）、
// 全局 Base64 字节上限、一次性消费；旧 {image} 单图上传兼容为单元素数组。
const crypto = require('crypto');

const visionUploadTokens = new Map(); // token → { images: [dataURI...], createdAt, username }
const TOKEN_TTL = 5 * 60 * 1000; // 5分钟过期（从 token 生成起算）
const MAX_VISION_TOKENS = 50; // 全局 token 上限，避免多张大图长期驻留 Web 进程内存（P1-7）
const MAX_BATCH_IMAGES = 6; // 每批最多 6 张
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 每张原始文件 ≤ 6MiB（解码后）
const MAX_BATCH_BYTES = 6 * 1024 * 1024; // 手机单次整批原始图片合计 ≤ 6MiB
const MAX_TOTAL_BASE64_BYTES = 64 * 1024 * 1024; // 全局已保存 Base64 字符串字节上限 64MiB

function isExpired(entry) {
  return !entry || (Date.now() - entry.createdAt) > TOKEN_TTL;
}

// 估算 data URI 解码后的字节数（base64 约 4/3 膨胀，按实际字符累计）
function base64PayloadBytes(dataUri) {
  const idx = String(dataUri || '').indexOf(',');
  return Math.floor((String(dataUri || '').length - idx - 1) * 3 / 4);
}

function totalStoredBytes() {
  let total = 0;
  for (const [, v] of visionUploadTokens) {
    for (const img of (v.images || [])) total += Buffer.byteLength(img, 'utf8');
  }
  return total;
}

function batchHash(images) {
  const h = crypto.createHash('sha256');
  for (const img of images) h.update(img);
  return h.digest('hex');
}

// 写入上传 token：同一用户只允许一个待上传 token（覆盖旧的），超出全局上限时淘汰最旧者
function setVisionToken(token, value) {
  for (const [k, v] of visionUploadTokens) {
    if (v.username === value.username) { visionUploadTokens.delete(k); break; }
  }
  if (visionUploadTokens.size >= MAX_VISION_TOKENS) {
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of visionUploadTokens) {
      const ts = v.createdAt || v.timestamp || 0;
      if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
    }
    if (oldestKey) visionUploadTokens.delete(oldestKey);
  }
  const entry = {
    images: Array.isArray(value.images) ? value.images.slice() : [],
    createdAt: value.createdAt || Date.now(),
    username: value.username,
    hash: null
  };
  if (entry.images.length) entry.hash = batchHash(entry.images);
  visionUploadTokens.set(token, entry);
}

// 定期清理过期token（unref：不阻止进程退出，避免内存泄漏，与 rateLimit 一致 P1-6）
const tokenSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of visionUploadTokens) {
    if (now - (v.createdAt || 0) > TOKEN_TTL) visionUploadTokens.delete(k);
  }
}, 60 * 1000);
if (tokenSweep.unref) tokenSweep.unref();

// 整批图片原子写入：全部校验通过后一次替换；同 token 重传相同批次可复用，内容不同明确报冲突。
// 返回 { ok: true } 或 { ok: false, code, error }
function saveVisionBatch(token, images, username) {
  const entry = visionUploadTokens.get(token);
  if (!entry) return { ok: false, code: 'expired', error: 'token已过期或不存在，请刷新电脑端重新生成二维码' };
  if (isExpired(entry)) {
    visionUploadTokens.delete(token);
    return { ok: false, code: 'expired', error: '二维码已过期，请刷新电脑端重新生成' };
  }
  if (username != null && entry.username !== username) {
    return { ok: false, code: 'forbidden', error: '无权上传到该二维码' };
  }
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (list.length === 0) return { ok: false, code: 'empty', error: '没有可上传的图片' };
  if (list.length > MAX_BATCH_IMAGES) {
    return { ok: false, code: 'too_many', error: '每批最多 ' + MAX_BATCH_IMAGES + ' 张，请分批上传' };
  }
  let batchBytes = 0;
  for (const img of list) {
    const bytes = base64PayloadBytes(img);
    if (bytes > MAX_IMAGE_BYTES) {
      return { ok: false, code: 'image_too_large', error: '单张图片过大（上限 6MiB），请重新截图' };
    }
    batchBytes += bytes;
  }
  if (batchBytes > MAX_BATCH_BYTES) {
    return { ok: false, code: 'batch_too_large', error: '本批图片合计过大（上限 6MiB），请分批上传' };
  }
  const hash = batchHash(list);
  // 一次性消费前的重复交付：相同批次可复用（幂等），不同内容不允许静默覆盖
  if (entry.images.length) {
    if (entry.hash === hash) return { ok: true, reused: true };
    return { ok: false, code: 'conflict', error: '该二维码已有一批待识别图片，内容不同不能覆盖，请刷新电脑端重新生成二维码' };
  }
  // 全局已保存 Base64 字节上限（按实际字节累计）：超限拒绝本批，不删其他有效批次
  const incomingBytes = list.reduce((s, img) => s + Buffer.byteLength(img, 'utf8'), 0);
  if (totalStoredBytes() + incomingBytes > MAX_TOTAL_BASE64_BYTES) {
    return { ok: false, code: 'capacity', error: '服务器上传额度已满，请稍后再试' };
  }
  entry.images = list;
  entry.hash = hash;
  return { ok: true };
}

// 消费上传 token：仅在图片存在且属于当前登录用户时返回并销毁 token（一次性消费）。
// 未上传只返回空 images（不删除，等待后续轮询）；其他用户访问返回 forbidden（不删除）。
// 过期即时检查，不依赖每分钟清扫。
function consumeVisionToken(token, username) {
  const entry = visionUploadTokens.get(token);
  if (!entry) return { images: [], image: null, expired: true, forbidden: false };
  if (isExpired(entry)) {
    visionUploadTokens.delete(token);
    return { images: [], image: null, expired: true, forbidden: false };
  }
  if (!entry.images || entry.images.length === 0) return { images: [], image: null, expired: false, forbidden: false };
  if (entry.username !== username) return { images: [], image: null, expired: false, forbidden: true };
  const images = entry.images.slice();
  visionUploadTokens.delete(token);
  // 旧 image 字段仅在一张时提供（多张时为 null，调用方走 images）
  return { images, image: images.length === 1 ? images[0] : null, expired: false, forbidden: false };
}

// 手机上传页面HTML（多选 + 本地预览/删除 + 整批上传；保留缩放）
function mobileUploadHtml(token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>上传交易截图</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:16px;padding:28px 20px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:360px;width:100%}
.icon{font-size:44px;margin-bottom:12px}
h2{font-size:18px;color:#1a1a2e;margin-bottom:8px}
p{font-size:13px;color:#888;margin-bottom:16px;line-height:1.5}
.hint{font-size:12px;color:#aaa;text-align:left;margin-bottom:16px;line-height:1.7}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:14px}
.thumb{position:relative;width:72px;height:72px}
.thumb img{width:100%;height:100%;object-fit:cover;border-radius:8px;border:1px solid #e0e0e0}
.thumb .del{position:absolute;top:-8px;right:-8px;width:24px;height:24px;border-radius:12px;border:none;background:#d93025;color:#fff;font-size:14px;line-height:24px;cursor:pointer}
.upload-btn{display:inline-block;background:#1a73e8;color:#fff;border:none;padding:14px 40px;border-radius:10px;font-size:16px;cursor:pointer;width:100%;min-height:48px}
.upload-btn:active{background:#1557b0}
.upload-btn:disabled{background:#9bb8e8}
.pick-btn{display:inline-block;background:#fff;color:#1a73e8;border:1px solid #1a73e8;padding:12px 40px;border-radius:10px;font-size:16px;cursor:pointer;width:100%;min-height:48px;margin-bottom:12px}
#status{margin-top:16px;font-size:14px;display:none;line-height:1.6}
input[type=file]{display:none}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📷</div>
  <h2>上传交易/持仓截图</h2>
  <p>可一次选多张（最多 6 张，合计不超过 6MB）</p>
  <div class="hint">建议截「持仓明细」或「交割单」：<br>· 持仓截图含代码、名称、成本价/买入均价、数量、单位、日期<br>· 交易截图含代码、名称、成交价、数量、买卖方向、日期及税费<br>账号可遮住，表头和证券字段请保留</div>
  <input type="file" id="fileInput" accept="image/*" multiple>
  <div class="thumbs" id="thumbs"></div>
  <button class="pick-btn" onclick="document.getElementById('fileInput').click()">🖼 选择图片</button>
  <button class="upload-btn" id="uploadBtn" disabled onclick="doUpload()">上传 0 张</button>
  <div id="status"></div>
</div>
<script>
var input = document.getElementById('fileInput');
var status = document.getElementById('status');
var uploadBtn = document.getElementById('uploadBtn');
var thumbs = document.getElementById('thumbs');
var selected = [];
var uploading = false;
function showStatus(text, color) {
  status.style.display = 'block';
  status.textContent = text;
  status.style.color = color || '#137333';
}
function renderThumbs() {
  thumbs.innerHTML = '';
  selected.forEach(function(item, i) {
    var wrap = document.createElement('div');
    wrap.className = 'thumb';
    var img = document.createElement('img');
    img.src = item.preview;
    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.onclick = function() { selected.splice(i, 1); renderThumbs(); };
    wrap.appendChild(img);
    wrap.appendChild(del);
    thumbs.appendChild(wrap);
  });
  uploadBtn.textContent = '上传 ' + selected.length + ' 张';
  uploadBtn.disabled = uploading || selected.length === 0;
}
input.addEventListener('change', function() {
  var files = Array.prototype.slice.call(input.files || []);
  files.forEach(function(file) {
    if (selected.length >= 6) { showStatus('每批最多 6 张，多余的未加入', '#d93025'); return; }
    var reader = new FileReader();
    reader.onload = function() {
      selected.push({ name: file.name, data: reader.result, preview: reader.result });
      renderThumbs();
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
});
function doUpload() {
  if (uploading || !selected.length) return;
  if (Date.now() - ${Date.now()} > 300000) {
    showStatus('❌ 二维码已过期，请刷新电脑端重新生成', '#d93025');
    return;
  }
  uploading = true;
  renderThumbs();
  showStatus('上传中...', '#888');
  fetch('/api/vision-upload/${token}', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({images: selected.map(function(x) { return x.data; })})
  }).then(function(r) { return r.json(); }).then(function(d) {
    uploading = false;
    renderThumbs();
    if (d.ok) {
      showStatus('✅ 已上传 ' + selected.length + ' 张！请返回电脑端查看识别结果', '#137333');
      selected = [];
      renderThumbs();
    } else {
      showStatus('❌ 上传失败: ' + (d.error || '未知错误'), '#d93025');
    }
  }).catch(function() {
    uploading = false;
    renderThumbs();
    showStatus('❌ 网络错误，请重试', '#d93025');
  });
}
renderThumbs();
</script>
</body>
</html>`;
}

module.exports = {
  visionUploadTokens, TOKEN_TTL, MAX_VISION_TOKENS, MAX_BATCH_IMAGES, MAX_IMAGE_BYTES, MAX_BATCH_BYTES, MAX_TOTAL_BASE64_BYTES,
  setVisionToken, mobileUploadHtml, consumeVisionToken, saveVisionBatch, isExpired, totalStoredBytes, base64PayloadBytes,
};
