// ========== 个人中心路由 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { getUserProfile, getUserAuth, updateUserProfile, changePassword, hashPwd, verifyPwd } = require('../db');
const AVATAR_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const passwordChangeLimit = rateLimit({
  prefix: 'profile-password', windowMs: 15 * 60 * 1000, max: 5,
  getKey: req => (req.ip || '0.0.0.0') + ':' + (req.session && req.session.user || ''),
  message: '改密尝试过多，请稍后再试'
});

// 资料读取：昵称/简介/头像/邮箱/最后登录 + 我的券商账户
router.get('/profile', requireLogin, asyncHandler(async (req, res) => {
  const p = await getUserProfile(req.session.user);
  if (!p) return res.status(404).json({ error: '用户不存在' });
  res.json(p);
}));

// 资料更新：昵称/简介/头像/邮箱（长度与格式校验，头像超长拦截）
router.put('/profile', requireLogin, asyncHandler(async (req, res) => {
  const { nickname, bio, avatar, email, currentPassword } = req.body || {};
  if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > 30)) {
    return res.status(400).json({ error: '昵称需在 30 字以内' });
  }
  if (bio !== undefined && (typeof bio !== 'string' || bio.length > 200)) {
    return res.status(400).json({ error: '简介需在 200 字以内' });
  }
  if (avatar !== undefined) {
    if (typeof avatar !== 'string') return res.status(400).json({ error: '头像数据格式错误' });
    if (avatar && !AVATAR_DATA_RE.test(avatar)) return res.status(400).json({ error: '头像数据格式错误' });
    if (avatar.length > 300000) return res.status(400).json({ error: '头像过大，请压缩后重试' });
  }
  if (email !== undefined && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (email !== undefined) {
    const current = await getUserProfile(req.session.user);
    const nextEmail = String(email || '').trim().toLowerCase();
    const oldEmail = String(current && current.email || '').trim().toLowerCase();
    if (nextEmail !== oldEmail) {
      const auth = await getUserAuth(req.session.user);
      if (typeof currentPassword !== 'string' || !verifyPwd(currentPassword, auth && auth.password)) {
        return res.status(401).json({ error: '修改邮箱需要验证当前密码' });
      }
    }
  }
  await updateUserProfile(req.session.user, { nickname, bio, avatar, email });
  res.json({ ok: true });
}));

// 修改密码：校验旧密码 + 新密码强度
router.post('/profile/password', requireLogin, passwordChangeLimit, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写旧密码和新密码' });
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) return res.status(400).json({ error: '新密码需为 6~128 位' });
  const user = await getUserAuth(req.session.user);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!verifyPwd(oldPassword, user.password)) return res.status(400).json({ error: '旧密码错误' });
  await changePassword(req.session.user, hashPwd(newPassword)); // 递增 auth_version，其他设备旧 Session 失效
  // 销毁当前会话，前端提示重新登录（AUTH-01）
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: '登录态清理失败，请重新登录' });
    res.json({ ok: true });
  });
}));

module.exports = router;
