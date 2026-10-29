// 独立来源登记；没有凭据，不改变现有主源优先级和历史业务数据。
async function migration178LixingerSource(pool) {
  await pool.query(`INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES('geoscope_lixinger','GeoScope／理杏仁','api',80)
    ON CONFLICT(source_code) DO NOTHING`);
  await pool.query(`INSERT INTO ops.source_endpoint_policies
    (source_id,api_name,credential_profile,permission_status,enabled,official_doc_url,notes)
    SELECT s.source_id,p.api_name,'primary',p.status,p.enabled,
      'https://geoscopeapp.com/skills/lixinger/skill.md','仅补主源失败或缺项；密钥只读 GEOSCOPE_API_KEY；未核验额度保持空值'
    FROM ops.data_sources s CROSS JOIN (VALUES
      ('cn.company','unknown',true),
      ('cn.company.fs.bank','unknown',true),
      ('cn.company.fs.security','unknown',true),
      ('cn.company.fundamental.non_financial','unknown',true),
      ('cn.company.industries','unknown',true),
      ('macro.gdp','unknown',true),
      ('cn.fund.net-value','permission_denied',false),
      ('cn.index.fundamental','permission_denied',false)
    ) p(api_name,status,enabled) WHERE s.source_code='geoscope_lixinger'
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING`);
}

module.exports = { migration178LixingerSource };
