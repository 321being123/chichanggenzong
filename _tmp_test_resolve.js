const { resolveInstrumentByName, resolveInstrumentByCode } = require('./server/services/arbitrageParser');
(async () => {
  const id = await resolveInstrumentByName('中国船舶');
  const id2 = await resolveInstrumentByName('中国船舶工业');
  const id3 = await resolveInstrumentByName('湘财股份');
  console.log('中国船舶 ->', id);
  console.log('中国船舶工业 ->', id2);
  console.log('湘财股份 ->', id3);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
