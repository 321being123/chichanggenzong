const assert=require('assert');
const {pool}=require('../db/connection');
const {markTerminalGap,terminalGap,TERMINAL_GAP_STATUSES}=require('../services/convertibleBondAnalysisInputs');
(async()=>{
  // 状态白名单只接受三种终态，其他状态不得当终态放行
  assert.deepStrictEqual([...TERMINAL_GAP_STATUSES],['source_unavailable','not_disclosed','conflict']);
  assert.strictEqual(terminalGap({},'rating'),null);
  assert.strictEqual(terminalGap({terminal_gaps:{}},'rating'),null);
  assert.strictEqual(terminalGap({terminal_gaps:{rating:{status:'blocked'}}},'rating'),null);
  assert.strictEqual(terminalGap({terminal_gaps:{rating:{status:'complete'}}},'rating'),null);
  assert.strictEqual(terminalGap({terminal_gaps:{rating:{status:'not_disclosed'}}},'rating').status,'not_disclosed');

  // 非法状态、缺原因、缺证据都必须拒绝，防止无证据关闭缺口
  await assert.rejects(()=>markTerminalGap('110081.SH','rating',{status:'blocked',reason:'r',evidence:{a:1}}),/不支持的资料终态/);
  await assert.rejects(()=>markTerminalGap('110081.SH','rating',{status:'conflict',evidence:{a:1}}),/必须写明原因/);
  await assert.rejects(()=>markTerminalGap('110081.SH','rating',{status:'conflict',reason:'r'}),/必须附带证据/);
  await assert.rejects(()=>markTerminalGap('110081.SH','rating',{status:'conflict',reason:'r',evidence:{}}),/必须附带证据/);

  // 真实库：写入后能读到，且不覆盖其他已有字段；用例结束恢复原值
  const code='110081.SH';
  const pick=async()=>(await pool.query(`SELECT p.instrument_id,p.raw_payload FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments i ON i.instrument_id=p.instrument_id WHERE i.canonical_code=$1`,[code])).rows[0];
  const before=await pick();
  assert(before,'测试债 110081.SH 必须在库内');
  const savedRaw=JSON.stringify(before.raw_payload);
  const savedParserVersion=before.raw_payload && before.raw_payload.analysis_inputs && before.raw_payload.analysis_inputs.parserVersion;
  try {
    const written=await markTerminalGap(code,'prospectus',{
      status:'source_unavailable',reason:'官方公告与备源均未覆盖该文种',
      evidence:{checked_sources:['sse','szse','tushare'],checked_through:'2026-10-23'},checkedAt:'2026-10-24T00:00:00+08:00'});
    assert.strictEqual(written.status,'source_unavailable');
    const after=await pick();
    const gap=after.raw_payload.analysis_inputs.terminal_gaps.prospectus;
    assert.strictEqual(gap.status,'source_unavailable');
    assert.strictEqual(gap.checkedAt,'2026-10-24T00:00:00+08:00');
    assert.deepStrictEqual(gap.evidence.checked_sources,['sse','szse','tushare']);
    assert.strictEqual(after.raw_payload.analysis_inputs.parserVersion,savedParserVersion,'写入终态不得改动解析版本');
    console.log('资料终态：白名单、拒绝无证据、真实库写入与证据保全通过');
  } finally {
    await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=$2::jsonb WHERE instrument_id=$1`,[before.instrument_id,savedRaw]);
    await pool.end();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
