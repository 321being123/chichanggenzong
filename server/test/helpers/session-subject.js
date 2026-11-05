// 测试用会话桩（F04）。
//
// 鉴权现在要求会话绑定"每次建号都不同的主体身份"（users.subject_id），
// 测试里手工拼的 `{user, authVersion}` 会因此被判失效——那是修复的预期效果，
// 不是测试环境特例。这个 helper 只是把"从库里取该用户的真实主体身份"这一步收敛成一处，
// 避免每个测试各写一遍 SQL，也避免有人为了省事把校验放宽。
'use strict';

const { pool } = require('../../db/connection');

async function subjectIdOf(username) {
  if (!username) return '';
  const { rows } = await pool.query('SELECT subject_id::text AS subject_id FROM users WHERE username=$1', [username]);
  return rows[0] ? String(rows[0].subject_id || '') : '';
}

/** 生成一个"真的属于该用户"的会话桩；extra 可覆盖任意字段。 */
async function testSession(username, extra = {}) {
  const subjectId = await subjectIdOf(username);
  return Object.assign({ user: username, authVersion: 1, subjectId }, extra);
}

/** 直接挂到 express：app.use(attachTestSession(() => U)) */
function attachTestSession(resolveUser) {
  return async function (req, res, next) {
    try {
      const username = typeof resolveUser === 'function' ? resolveUser(req) : resolveUser;
      req.session = await testSession(username);
      next();
    } catch (error) { next(error); }
  };
}

module.exports = { subjectIdOf, testSession, attachTestSession };
