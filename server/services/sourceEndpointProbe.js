// 外部接口权限探针：只验证被停用接口是否恢复，不参与业务数据采集。
const { pool } = require('../db/connection');
const cninfo = require('./cninfoAnnouncement');
const {
  claimPermissionProbes,
  recordEndpointPermission,
} = require('./sourceEndpointPolicy');

const CNINFO_TOP_SEARCH_URL = 'https://www.cninfo.com.cn/new/information/topSearch/query';

async function latestCninfoDocumentUrl() {
  const { rows } = await pool.query(`
    SELECT d.url
      FROM event.documents d
      JOIN ops.data_sources ds ON ds.source_id=d.source_id
     WHERE ds.source_code='cninfo_announcements'
       AND d.url ~* '\\.pdf($|\\?)'
     ORDER BY d.created_at DESC,d.document_id DESC
     LIMIT 1
  `);
  return rows[0] && rows[0].url || null;
}

function probeTarget(apiName, documentUrl) {
  if (apiName === 'document' || apiName === '*') {
    return documentUrl ? { url: documentUrl, method: 'HEAD' } : null;
  }
  if (apiName === 'topSearch') {
    return {
      url: CNINFO_TOP_SEARCH_URL,
      method: 'POST',
      body: new URLSearchParams({ keyWord: '601995', maxNum: '1' }).toString(),
    };
  }
  return null;
}

async function probeCninfoPermission() {
  const claims = await claimPermissionProbes('cninfo', 'anonymous');
  if (!claims.length) return { status: 'not_due', attempted: 0, recovered: 0, results: [] };

  const documentUrl = claims.some(item => item.api_name === 'document' || item.api_name === '*')
    ? await latestCninfoDocumentUrl()
    : null;
  const results = [];
  let recovered = 0;
  for (const claim of claims) {
    const target = probeTarget(claim.api_name, documentUrl);
    if (!target) {
      results.push({ apiName: claim.api_name, status: 'no_probe_target', nextProbeAt: claim.nextProbeAt });
      continue;
    }
    try {
      await cninfo.probeEndpoint(target.url, { apiName: claim.api_name, method: target.method, body: target.body });
      await recordEndpointPermission('cninfo', 'anonymous', claim.api_name, claim.credential_fingerprint, {
        status: 'available', message: '定期权限探针成功，接口已恢复可用',
      });
      recovered++;
      results.push({ apiName: claim.api_name, status: 'available', nextProbeAt: claim.nextProbeAt });
    } catch (error) {
      if (String(error && error.code || '').toUpperCase() === 'HTTP_403') {
        await recordEndpointPermission('cninfo', 'anonymous', claim.api_name, claim.credential_fingerprint, {
          status: 'permission_denied', message: '定期权限探针仍返回 HTTP 403',
        });
      }
      results.push({
        apiName: claim.api_name,
        status: 'unavailable',
        code: String(error && error.code || 'PROBE_FAILED').toUpperCase(),
        message: String(error && error.message || error).slice(0, 240),
        nextProbeAt: claim.nextProbeAt,
      });
    }
  }
  return {
    status: recovered ? 'available' : 'unavailable',
    attempted: claims.length,
    recovered,
    results,
  };
}

module.exports = {
  probeCninfoPermission,
  probeTarget,
  latestCninfoDocumentUrl,
};
