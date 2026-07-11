// ========== 手机扫码上传（in-memory token store + 页面模板） ==========
const visionUploadTokens = new Map(); // token → { image, timestamp, username }
const TOKEN_TTL = 5 * 60 * 1000; // 5分钟过期

// 定期清理过期token
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of visionUploadTokens) {
    if (now - v.timestamp > TOKEN_TTL) visionUploadTokens.delete(k);
  }
}, 60 * 1000);

// 消费上传 token：仅在图片存在且属于当前登录用户时返回并销毁 token；
// 未上传只返回 image:null（不删除，等待后续轮询）；其他用户访问返回 forbidden（不删除）。
// 返回 { image, expired, forbidden }
function consumeVisionToken(token, username) {
  const entry = visionUploadTokens.get(token);
  if (!entry) return { image: null, expired: true, forbidden: false };
  if (Date.now() - entry.timestamp > TOKEN_TTL) {
    visionUploadTokens.delete(token);
    return { image: null, expired: true, forbidden: false };
  }
  if (!entry.image) return { image: null, expired: false, forbidden: false };
  if (entry.username !== username) return { image: null, expired: false, forbidden: true };
  visionUploadTokens.delete(token);
  return { image: entry.image, expired: false, forbidden: false };
}

// 手机上传页面HTML
function mobileUploadHtml(token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>上传交易截图</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:340px;width:100%}
.icon{font-size:48px;margin-bottom:16px}
h2{font-size:18px;color:#1a1a2e;margin-bottom:8px}
p{font-size:13px;color:#888;margin-bottom:24px}
.upload-btn{display:inline-block;background:#1a73e8;color:#fff;border:none;padding:14px 40px;border-radius:10px;font-size:16px;cursor:pointer;width:100%}
.upload-btn:active{background:#1557b0}
#status{margin-top:16px;font-size:14px;color:#137333;display:none}
input[type=file]{display:none}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📷</div>
  <h2>上传交易截图</h2>
  <p>拍照或从相册选择交易记录截图</p>
  <input type="file" id="fileInput" accept="image/*">
  <button class="upload-btn" onclick="document.getElementById('fileInput').click()">📸 拍照 / 选图</button>
  <div id="status"></div>
</div>
<script>
var input = document.getElementById('fileInput');
var status = document.getElementById('status');
input.addEventListener('change', async function() {
  var file = input.files[0];
  if (!file) return;
  status.style.display = 'block';
  status.textContent = '上传中...';
  var reader = new FileReader();
  reader.onload = async function() {
    try {
      var r = await fetch('/api/vision-upload/${token}', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({image: reader.result})
      });
      var d = await r.json();
      if (d.ok) {
        status.textContent = '✅ 上传成功！请返回电脑端查看识别结果';
        status.style.color = '#137333';
      } else {
        status.textContent = '❌ 上传失败: ' + (d.error || '未知错误');
        status.style.color = '#d93025';
      }
    } catch(e) {
      status.textContent = '❌ 网络错误，请重试';
      status.style.color = '#d93025';
    }
  };
  reader.readAsDataURL(file);
});
</script>
</body>
</html>`;
}

module.exports = { visionUploadTokens, TOKEN_TTL, mobileUploadHtml, consumeVisionToken };
