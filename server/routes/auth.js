// ========== 用户认证路由 ==========
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const rateLimit = require('../middleware/rateLimit');
const { requireLogin, checkLocked, recordFail, clearFail, checkRegLimit } = require('../middleware/auth');
const { mailer, REGISTER_CODE } = require('../config');
const { registerUser, hashPwd, verifyPwd, isLegacyHash, changePassword, syncUserAccounts, getUserProfile, getUserAuth, updateUserProfile, updateLastLogin, getConfig } = require('../db');

router.post('/register', asyncHandler(async (req, res) => {
  const username = (req.body && req.body.username || '').normalize('NFC').trim();
  const password = (req.body && req.body.password || '').normalize('NFC');
  const { code, email, emailCode } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length < 2 || username.length > 64) return res.status(400).json({ error: '账号需为 2~64 位' });
  if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码需为 6~128 位' });
  // 仅允许常见字符，拒绝控制字符等异常输入
  if (!/^[\w.\-@]+$/.test(username)) return res.status(400).json({ error: '账号含非法字符' });
  // 注册总开关（DB 优先，默认开放）
  if ((await getConfig('register_open', '1')) !== '1') return res.status(403).json({ error: '注册已关闭' });
  // 邀请码（DB 优先于 env REGISTER_CODE）
  const regCode = (await getConfig('register_code', REGISTER_CODE || '')) || '';
  if (regCode && code !== regCode) return res.status(400).json({ error: '注册已关闭或邀请码错误' });
  // 邮箱验证开关：开启后必须配置邮件服务，否则拒绝注册（P1-1：禁止静默绕过）
  const needEmail = (await getConfig('require_email', '0')) === '1';
  if (needEmail) {
    if (!mailer) return res.status(503).json({ error: '邮箱验证服务暂不可用，无法完成注册' });
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
  // 原子注册：唯一约束判重，并发不会互相覆盖快照；rowCount=0 表示已存在
  const inserted = await registerUser(username, hashPwd(password), ['默认账户']);
  if (!inserted) return res.status(400).json({ error: '该账号已注册，请直接登录' });
  // 顺手把注册邮箱写入 users.email 列（registerUser 只持久化 username/password/accounts，否则邮箱会丢）
  if (email) await updateUserProfile(username, { email }).catch(() => {});
  // P2-3：同步结构化 accounts 表，新用户即拥有账户元数据行（cash_base/hk_rate 用默认）
  await syncUserAccounts(username, ['默认账户']).catch(() => {});
  req.session.user = username;
  res.json({ ok: true, username });
}));

router.post('/login', asyncHandler(async (req, res, next) => {
  const username = (req.body && req.body.username || '').normalize('NFC').trim();
  const password = (req.body && req.body.password || '').normalize('NFC');
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length > 64 || password.length > 128) return res.status(400).json({ error: '账号或密码格式错误' });
  const ip = req.ip || req.connection.remoteAddress;
  const lockKey = 'login_' + username + '_' + ip;
  if (checkLocked(lockKey)) return res.status(429).json({ error: '登录尝试过多，已锁定15分钟' });
  const user = await getUserAuth(username);
  // 统一模糊错误（P1-1）：账号不存在与密码错误返回相同提示，避免枚举账号
  if (!user) { recordFail(lockKey); return res.status(401).json({ error: '账号或密码错误' }); }
  if (user.status && user.status !== 'active') { recordFail(lockKey); return res.status(403).json({ error: '该账号已被禁用，请联系管理员' }); }
  if (!verifyPwd(password, user.password)) { recordFail(lockKey); return res.status(401).json({ error: '账号或密码错误' }); }
  clearFail(lockKey);
  // 渐进迁移：旧哈希格式（pbkdf2/sha256）登录成功后，透明升级为新 scrypt 哈希（P1-5）
  if (isLegacyHash(user.password)) {
    changePassword(username, hashPwd(password)).catch(() => {});
  }
  // 会话固定防护（P1-1）：登录成功后重建会话，丢弃旧会话ID，防会话固定攻击
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = username;
    updateLastLogin(username).catch(() => {});
    res.json({ ok: true, username, role: user.role || 'user' });
  });
}));

router.post('/logout', (req, res) => {
  // 等待 destroy 回调完成后再响应（P1-1），确保会话确实清除
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: '登出失败，请重试' });
    res.json({ ok: true });
  });
});
router.get('/me', asyncHandler(async (req, res) => {
  if (!req.session.user) return res.json({ username: null });
  const p = await getUserProfile(req.session.user);
  res.json({ username: p.username, nickname: p.nickname || '', avatar: p.avatar || '', role: p.role || 'user', status: p.status || 'active' });
}));
router.get('/config', asyncHandler(async (req, res) => { res.json({ needRegisterCode: !!(await getConfig('register_code', REGISTER_CODE || '')) }); }));

// 发送邮箱验证码（IP+邮箱 联合限流，复用现有内存/Redis 限流中间件）
router.post('/send-code',
  rateLimit({
    prefix: 'emailcode',
    windowMs: 60000,
    max: 5,
    getKey: (req) => (req.ip || '0.0.0.0') + ':' + ((req.body && req.body.email) || ''),
    message: '发送验证码过于频繁，请稍后再试'
  }),
  asyncHandler(async (req, res) => {
  if (!mailer) return res.status(500).json({ error: '邮件服务未配置' });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  // 60秒内限制同一邮箱重复发送
  const sess = req.session;
  if (sess.emailCode && sess.emailCode.lastSend && Date.now() - sess.emailCode.lastSend < 60000) {
    return res.status(429).json({ error: '发送太频繁，请60秒后再试' });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  sess.emailCode = { code, email, expires: Date.now() + 300000, lastSend: Date.now() };
  await mailer.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: '存在小站 - 注册验证码',
    text: `您的验证码是：${code}，5分钟内有效。请勿泄露给他人。`
  });
  res.json({ ok: true });
}));

module.exports = router;
