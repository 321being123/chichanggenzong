// 现金收益展示只读统一证券主档；存量回购/实际补录以事件键中的身份关联，不回写流水。
const { resolveInstrument } = require('./securityIdentity');
const classifyCode = require('../../public/js/code-classify');

function identityReference(flow) {
  if (['dividend', 'dividend_tax'].includes(flow.flow_type)) {
    const eventId = flow.event_key?.match(/^dividend:(\d+):/)?.[1];
    if (eventId && flow.instrument_id && String(flow.instrument_id) !== eventId) return null;
    const instrumentId = flow.instrument_id || eventId;
    return instrumentId ? { instrumentId } : null;
  }
  if (['repo_interest', 'repo_fee'].includes(flow.flow_type)) {
    const canonicalCode = flow.event_key?.match(/^repo:(\d{6}\.(?:SH|SZ)):\d{4}-\d{2}-\d{2}$/)?.[1];
    return canonicalCode ? { canonicalCode } : null;
  }
  return null;
}

async function attachCashFlowIdentity(flows, query) {
  const identities = new Map();
  for (const flow of flows) {
    const reference = identityReference(flow);
    if (!reference) continue;
    const key = JSON.stringify(reference);
    if (!identities.has(key)) identities.set(key, await resolveInstrument(reference, query));
    const identity = identities.get(key);
    if (!identity) continue;
    flow.code = classifyCode.normalizeCode(identity.canonical_code, identity.name);
    flow.name = identity.name || null;
  }
  return flows;
}

module.exports = { identityReference, attachCashFlowIdentity };
