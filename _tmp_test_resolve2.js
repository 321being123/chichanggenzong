const { resolveInstrumentByName } = require('./server/services/arbitrageParser');
(async () => {
  for (const n of ['湘财','中国重工','中国船舶','大智慧']) {
    const id = await resolveInstrumentByName(n);
    console.log(n, '->', id);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
