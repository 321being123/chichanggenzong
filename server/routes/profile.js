// ========== 个人中心路由 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const { getUserProfile, getUserAuth, updateUserProfile, changePassword, hashPwd, verifyPwd } = require('../db');

// 资料读取：昵称/简介/头像/邮箱/最后登录 + 我的券商账户
router.get('/profile', requireLogin, asyncHandler(async (req, res) => {
  const p = await getUserProfile(req.session.user);
  if (!p) return res.status(404).json({ error: '用户不存在' });
  res.json(p);
}));

// 资料更新：昵称/简介/头像/邮箱（长度与格式校验，头像超长拦截）
router.put('/profile', requireLogin, asyncHandler(async (req, res) => {
  const { nickname, bio, avatar, email } = req.body || {};
  if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > 30)) {
    return res.status(400).json({ error: '昵称需在 30 字以内' });
  }
  if (bio !== undefined && (typeof bio !== 'string' || bio.length > 200)) {
    return res.status(400).json({ error: '简介需在 200 字以内' });
  }
  if (avatar !== undefined) {
    if (typeof avatar !== 'string') return res.status(400).json({ error: '头像数据格式错误' });
    if (avatar && !avatar.startsWith('data:image/')) return res.status(400).json({ error: '头像需为图片' });
    if (avatar.length > 300000) return res.status(400).json({ error: '头像过大，请压缩后重试' });
  }
  if (email !== undefined && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  await updateUserProfile(req.session.user, { nickname, bio, avatar, email });
  res.json({ ok: true });
}));

// 修改密码：校验旧密码 + 新密码强度
router.post('/profile/password', requireLogin, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写旧密码和新密码' });
  if (typeof newPassword !== 'string' || newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const user = await getUserAuth(req.session.user);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!verifyPwd(oldPassword, user.password)) return res.status(400).json({ error: '旧密码错误' });
  await changePassword(req.session.user, hashPwd(newPassword));
  res.json({ ok: true });
}));

module.exports = router;
