// ========== 用户认证路由 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, checkLocked, recordFail, clearFail, checkRegLimit } = require('../middleware/auth');
const { mailer, REGISTER_CODE } = require('../config');
const { loadUsers, saveUsers, hashPwd, verifyPwd, syncUserAccounts } = require('../db');

router.post('/register', asyncHandler(async (req, res) => {
  const { username, password, code, email, emailCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length < 2) return res.status(400).json({ error: '账号至少2位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (REGISTER_CODE && code !== REGISTER_CODE) return res.status(400).json({ error: '注册已关闭或邀请码错误' });
  // 邮箱验证码校验
  if (mailer) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入正确的邮箱' });
    if (!emailCode) return res.status(400).json({ error: '请输入邮箱验证码' });
    const sess = req.session;
    if (!sess.emailCode || sess.emailCode.email !== email || sess.emailCode.code !== emailCode) {
      return res.status(400).json({ error: '验证码错误' });
    }
    if (Date.now() > sess.emailCode.expires) return res.status(400).json({ error: '验证码已过期，请重新获取' });
    delete sess.emailCode;
  }
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRegLimit(ip)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const users = await loadUsers();
  if (users[username]) return res.status(400).json({ error: '该账号已注册，请直接登录' });
  users[username] = { password: hashPwd(password), email, accounts: ['默认账户'] };
  await saveUsers(users);
  // P2-3：同步结构化 accounts 表，新用户即拥有账户元数据行（cash_base/hk_rate 用默认）
  await syncUserAccounts(username, ['默认账户']).catch(() => {});
  req.session.user = username;
  res.json({ ok: true, username });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  const ip = req.ip || req.connection.remoteAddress;
  const lockKey = 'login_' + (username || '') + '_' + ip;
  if (checkLocked(lockKey)) return res.status(429).json({ error: '登录尝试过多，已锁定15分钟' });
  const users = await loadUsers();
  const user = users[username];
  if (!user) { recordFail(lockKey); return res.status(401).json({ error: '账号不存在，请先注册' }); }
  if (!verifyPwd(password, user.password)) { recordFail(lockKey); return res.status(401).json({ error: '密码错误' }); }
  clearFail(lockKey);
  req.session.user = username;
  res.json({ ok: true, username });
}));

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
router.get('/me', (req, res) => { res.json({ username: req.session.user || null }); });
router.get('/config', (req, res) => { res.json({ needRegisterCode: !!REGISTER_CODE }); });

// 发送邮箱验证码
router.post('/send-code', asyncHandler(async (req, res) => {
  if (!mailer) return res.status(500).json({ error: '邮件服务未配置' });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  // 60秒内限制同一邮箱重复发送
  const sess = req.session;
  if (sess.emailCode && sess.emailCode.lastSend && Date.now() - sess.emailCode.lastSend < 60000) {
    return res.status(429).json({ error: '发送太频繁，请60秒后再试' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  sess.emailCode = { code, email, expires: Date.now() + 300000, lastSend: Date.now() };
  await mailer.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: '持仓管理系统 - 注册验证码',
    text: `您的验证码是：${code}，5分钟内有效。请勿泄露给他人。`
  });
  res.json({ ok: true });
}));

module.exports = router;
