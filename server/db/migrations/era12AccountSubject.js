// 187：用户主体身份（F04）。
//
// 背景：会话此前只绑定 `username + auth_version`。删号后同名重建，`auth_version` 会回到默认值，
// 旧会话如果还在有效期内、且没有经过删号后的失效检查，就会被当成新账号的会话。
// 前端 `/me` 已有 accountIdentity 概念，但它没有参与后端授权判定，前端缓存隔离替代不了鉴权。
//
// 本迁移只做纯增量：给 users 加一个**每次建号都不同**的不可变主体身份 subject_id，
// 旧行由 volatile 默认逐行生成，不改写任何业务数据、不删除任何行。
// 之后鉴权统一校验「主体 ID + auth_version + 状态」，username 只作为可读标识。
async function migration187UserSubjectIdentity(pool) {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name='subject_id'
      ) THEN
        ALTER TABLE users ADD COLUMN subject_id uuid NOT NULL DEFAULT gen_random_uuid();
      END IF;
    END $$;
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_subject_id ON users(subject_id)');
}

module.exports = { migration187UserSubjectIdentity };
