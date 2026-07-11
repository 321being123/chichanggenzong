// ========== 元信息路由（更新日志等） ==========
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');

// 版本更新日志
router.get('/changelog', requireLogin, (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf-8');
    res.json({ content: content });
  } catch (e) {
    res.status(500).json({ error: '无法加载更新日志' });
  }
});

module.exports = router;
