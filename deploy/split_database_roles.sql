-- 迁移账号拆分：只迁移对象所有权和权限，不修改业务数据。
-- 执行前必须完成数据库备份；密码由维护命令通过 ALTER ROLE 单独设置，不写入本文件。
-- 运行账号：portfolio_user；迁移对象所有者：portfolio_owner；登录迁移账号：portfolio_migrator。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_owner') THEN
    CREATE ROLE portfolio_owner NOLOGIN;
  ELSE
    ALTER ROLE portfolio_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_migrator') THEN
    CREATE ROLE portfolio_migrator LOGIN;
  ELSE
    ALTER ROLE portfolio_migrator LOGIN;
  END IF;
END
$$;

GRANT portfolio_owner TO portfolio_migrator;
GRANT CONNECT, TEMPORARY ON DATABASE portfolio TO portfolio_user, portfolio_migrator;
REVOKE CREATE ON DATABASE portfolio FROM portfolio_user;

REASSIGN OWNED BY portfolio_user TO portfolio_owner;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname NOT LIKE 'pg_%'
       AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO portfolio_owner', item.nspname);
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO portfolio_owner', item.nspname);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM portfolio_user', item.nspname);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', item.nspname);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO portfolio_user', item.nspname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO portfolio_user', item.nspname);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO portfolio_user', item.nspname);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO portfolio_user', item.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO portfolio_user', item.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_owner IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO portfolio_user', item.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_owner IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO portfolio_user', item.nspname);
  END LOOP;
END
$$;

COMMIT;
