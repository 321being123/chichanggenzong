const { pool } = require('../db');

const events = [
  { code: '127067.SZ', type: 'exercise', announcedAt: '2026-08-18', noCallUntil: null, url: 'https://static.cninfo.com.cn/finalpage/2026-08-18/1225478796.PDF', title: '关于提前赎回恒逸转2的公告' },
  { code: '123241.SZ', type: 'waive', announcedAt: '2026-05-07', noCallUntil: '2026-08-07', url: 'https://static.cninfo.com.cn/finalpage/2026-05-07/1225281357.PDF', title: '关于不提前赎回欧陆转债的公告' },
  { code: '123258.SZ', type: 'waive', announcedAt: '2026-05-19', noCallUntil: '2026-08-19', url: 'https://static.cninfo.com.cn/finalpage/2026-05-19/1225318093.PDF', title: '关于不提前赎回胜蓝转债的公告' },
];

(async () => {
  const source = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='convertible_bond_redemption_announcements'");
  if (!source.rows[0]) throw new Error('强赎公告数据源不存在');
  const sourceId = source.rows[0].source_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const event of events) {
      const instrument = await client.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [event.code]);
      if (!instrument.rows[0]) throw new Error(`找不到转债 ${event.code}`);
      await client.query(`
        INSERT INTO event.convertible_bond_call_events
          (instrument_id,event_type,announced_at,no_call_until,source_id,source_key,source_url,title,parse_status,parser_version,details,raw_payload)
        VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,'complete','call-event-v2',$9::jsonb,$10::jsonb)
        ON CONFLICT(source_id,source_key) DO UPDATE SET
          instrument_id=EXCLUDED.instrument_id,event_type=EXCLUDED.event_type,announced_at=EXCLUDED.announced_at,
          no_call_until=EXCLUDED.no_call_until,source_url=EXCLUDED.source_url,title=EXCLUDED.title,
          parse_status=EXCLUDED.parse_status,parser_version=EXCLUDED.parser_version,details=EXCLUDED.details,
          raw_payload=EXCLUDED.raw_payload,updated_at=now()`,
        [instrument.rows[0].instrument_id, event.type, event.announcedAt, event.noCallUntil, sourceId, event.url,
          event.url, event.title, JSON.stringify({ parser: 'official-pdf', source: 'cninfo' }), JSON.stringify(event)]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ updated: events.map(event => event.code) }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); await pool.end(); }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
