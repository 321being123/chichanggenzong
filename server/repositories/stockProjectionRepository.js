// 股票标准投影仓储（批次1，从 financialDataArchitecture 迁入的 SQL 写入）。
// 合同：method(params..., client) 的第一个参数始终是调用方事务 client；
// 本文件只做 SQL 与标准事实写入，不判断业务规则、不触发外采、不自行 BEGIN/COMMIT。
const { ensureInstrumentIdentity } = require('../services/securityIdentity');
const { upsertIndustryPath } = require('./industryRepository');
const reportMetrics = require('../dataAccess/lixingerReportMetrics');
const {
  FACT_MAP, METRICS, analysisMetricValues, asDate, finite, hash, resolvePeriodType, rowVersion, stablePayload,
} = require('../domain/stockFacts');

async function sourceIds(client) {
  const { rows } = await client.query('SELECT source_code,source_id FROM ops.data_sources');
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

async function ensureMaster(client, tsCode, sources, metadata) {
  let legacy = metadata ? { ...metadata, data: metadata } : null;
  if (!legacy) {
    const current = (await client.query(`SELECT canonical_code ts_code,name,market,to_char(list_date,'YYYYMMDD') list_date,raw_data data FROM core.instruments WHERE canonical_code=$1`, [tsCode])).rows[0];
    legacy = current ? { ...current, industry: current.data?.industry || '' } : null;
  }
  if (!legacy) throw new Error(`缺少证券基础资料：${tsCode}`);
  const raw = legacy.data || {}, exchange = tsCode.endsWith('.SH') ? 'SSE' : tsCode.endsWith('.BJ') ? 'BSE' : 'SZSE';
  const currency = tsCode.endsWith('.HK') ? 'HKD' : 'CNY', assetClass='stock';
  const marketCode = (legacy.market === 'CN' || legacy.market === 'HK') ? legacy.market : (tsCode.endsWith('.HK') ? 'HK' : 'CN');
  const master = await ensureInstrumentIdentity({ canonicalCode: tsCode, name: legacy.name || '', assetClass, market: marketCode, exchangeCode: exchange, currencyCode: currency, listDate: asDate(legacy.list_date), status: 'listed', rawData: raw, companyName: legacy.name || tsCode }, client.query.bind(client));
  const company = { company_id: master.companyId };
  const instrument = { instrument_id: master.instrumentId };
  const industryName = raw.industry || legacy.industry || '', system = raw.industry_system || 'Tushare基础行业', levelText = raw.industry_level || '';
  if (industryName) {
    // 行业必须整条路径入库（一级/二级/三级 + 父子关系）：只存最深处会让"按一级行业控上限"
    // 和所有按行业分组的查询都取不到分类。分类体系按来源判定，恒生与申万互不顶替。
    const taxonomyCode = /恒生/.test(system) ? 'HSICS' : (/申万/.test(system) ? 'SW2021' : 'TUSHARE_BASIC');
    const level = Number((String(levelText).match(/\d+/) || [])[0]) || null;
    const nodes = (Array.isArray(raw.industry_nodes) && raw.industry_nodes.length)
      ? raw.industry_nodes.map(node => ({ code: node.code, name: node.name, level: node.level }))
      : [{
        code: String(raw.industry_code || hash(`${taxonomyCode}|${industryName}`).slice(0, 16)),
        name: industryName,
        level,
      }];
    await upsertIndustryPath({
      companyId: company.company_id,
      taxonomyCode,
      taxonomyName: taxonomyCode === 'HSICS' ? '恒生行业分类' : (taxonomyCode === 'SW2021' ? '申万行业' : 'Tushare基础行业'),
      taxonomyVersion: taxonomyCode === 'SW2021' ? '2021' : '',
      nodes,
      sourceCode: raw.industry_source || 'tushare',
      validFrom: asDate(legacy.list_date),
    }, client);
  }
  const controller = raw.actual_controller;
  if (controller && controller.name) {
    await client.query(`UPDATE core.company_controllers SET is_current=false,valid_to=CURRENT_DATE WHERE company_id=$1 AND is_current=true AND controller_name<>$2`, [company.company_id, controller.name]);
    await client.query(`INSERT INTO core.company_controllers(company_id,controller_name,controller_type,control_ratio,source_id,valid_from,is_current,confidence,raw_data)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb) ON CONFLICT(company_id,controller_name,valid_from) DO UPDATE SET controller_type=EXCLUDED.controller_type,control_ratio=EXCLUDED.control_ratio,is_current=true,raw_data=EXCLUDED.raw_data`,
      [company.company_id, controller.name, controller.type || 'other', finite(controller.hold_ratio), sources.eastmoney, asDate(legacy.list_date), controller.name ? 0.8 : null, JSON.stringify(controller)]);
  }
  return { companyId: company.company_id, instrumentId: instrument.instrument_id, legacy, currency };
}

/**
 * 三表宽表写入（迁移 186）：一行一份报告，列 = 字典科目（bs.ta → bs_ta）。
 * A股（CAS）与港股（HKFRS）各自一张表，科目集合不同，禁止串用。
 * 只写有值的科目；同 report_id 幂等覆盖，不删旧值以外的列。
 */
async function writeStatementWideRow(client, params) {
  const {
    reportId, companyId, market, kind, periodEnd, periodType,
    announcedAt, currency, sourceId, sourceVersion, rawRecordId, metrics,
  } = params;
  if (!reportMetrics.STATEMENTS.includes(kind)) return 0;
  if (!reportId || !companyId || !periodEnd) return 0;
  const table = reportMetrics.tableNameOf(market, kind);
  const columns = ['report_id', 'company_id', 'period_end', 'period_type', 'announced_at',
    'currency_code', 'accounting_standard', 'source_id', 'source_version', 'raw_record_id'];
  const values = [reportId, companyId, periodEnd, periodType || null, announcedAt || null,
    currency || null, reportMetrics.standardOf(market), sourceId || null, sourceVersion || null, rawRecordId || null];
  for (const metric of reportMetrics.metricsByStatement(market, kind)) {
    const value = finite(metrics && metrics[metric.code]);
    if (value === null) continue;
    columns.push(reportMetrics.columnOf(metric.code));
    values.push(value);
  }
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const updates = columns.slice(1).map(name => `${name}=EXCLUDED.${name}`).join(',');
  await client.query(`INSERT INTO ${table}(${columns.join(',')})
    VALUES(${placeholders.join(',')})
    ON CONFLICT (report_id) DO UPDATE SET ${updates}, ingested_at=now()`, values);
  return columns.length;
}

async function syncReportRows(client, rows, kind, companyId, sourceId, options = {}) {
  // 会计准则按市场隔离：港股标的走 HKFRS 宽表，其余走 CAS 宽表。
  const market = /\.HK$/i.test(String(options.tsCode || '')) ? 'HK' : 'CN';
  for (const rawData of rows) {
    if (!asDate(rawData.end_date)) continue;
    // 三表全量科目与报告本体分开：科目写宽表，报告本体写 financial_reports / 原始留证，
    // 避免几百个科目在两份 JSONB 里重复膨胀。
    const statementMetrics = rawData.__statement_metrics && typeof rawData.__statement_metrics === 'object'
      ? rawData.__statement_metrics : null;
    const data = statementMetrics
      ? (() => { const { __statement_metrics, ...rest } = rawData; return rest; })()
      : rawData;
    if (options.reportTypeOnly && String(data.report_type || '') !== String(options.reportTypeOnly)) continue;
    const { __statement_comparisons: _cmp, ...rawVersionPayload } = data;
    const versionPayload = rawVersionPayload.__statement_coverage && typeof rawVersionPayload.__statement_coverage === 'object'
      ? (() => {
        const {
          requested_metric_codes, returned_metric_codes, requested_batch_count,
          returned_batch_count, complete, comparison_requested, comparison_complete, ...covRest
        } = rawVersionPayload.__statement_coverage;
        return { ...rawVersionPayload, __statement_coverage: covRest };
      })()
      : rawVersionPayload;
    let sourceVersion = rowVersion(versionPayload);
    const announced = asDate(data.ann_date), fAnnDate = asDate(data.f_ann_date || data.ann_date);
    // 报告期类型与金额币种都必须来自事实本身（R2-03）：港股 3 月年报不能被月份推断成 q1，
    // USD 报表金额也不能落成 CNY。行里没有币种时按证券主档币种兜底，而不是一律 CNY。
    const rowPeriodType = resolvePeriodType(data);
    const rowCurrency = String(data.currency || options.currency || (/\.(SH|SZ|BJ)$/i.test(String(options.tsCode || '')) ? 'CNY' : '')).toUpperCase() || null;
    const targetTsCode = String(data.ts_code || options.tsCode || '').trim().toUpperCase();
    const targetScope = String(data.report_type || '') === '1'
      ? 'consolidated'
      : String(data.statement_scope || 'consolidated');
    const sameIdentity = sourceId ? (await client.query(
      `SELECT source_version, raw_payload
         FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind=$2 AND period_end=$3 AND source_id=$4
          AND upper(COALESCE(raw_payload->>'ts_code','')) = $5
          AND announced_at IS NOT DISTINCT FROM $6::date
          AND f_ann_date IS NOT DISTINCT FROM $7::date
          AND upper(COALESCE(NULLIF(raw_payload->>'currency',''),
            CASE WHEN upper(COALESCE(raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' THEN 'CNY' ELSE '' END)) = $8
          AND COALESCE(statement_scope,'consolidated') = $9
          AND COALESCE(NULLIF(report_type,''),'') = $10
          AND COALESCE(NULLIF(comp_type,''),'') = $11
          AND COALESCE(NULLIF(update_flag,''),'') = $12
        ORDER BY CASE WHEN COALESCE((raw_payload->'__statement_coverage'->>'complete')::boolean, true) THEN 0 ELSE 1 END,
          ingested_at DESC, report_id DESC
        LIMIT 1`,
      [
        companyId, kind, asDate(data.end_date), sourceId, targetTsCode,
        announced || null, fAnnDate || null, rowCurrency || '',
        targetScope, String(data.report_type || ''), String(data.comp_type || ''), String(data.update_flag || ''),
      ]
    )).rows[0] : null;
    const isIncomplete = Boolean(data.__statement_coverage && data.__statement_coverage.complete === false);
    const missingPreviouslyCollectedField = Boolean(
      sameIdentity && sameIdentity.raw_payload && typeof sameIdentity.raw_payload === 'object'
      && Object.entries(FACT_MAP[kind] || {}).some(([sourceField]) =>
        finite(sameIdentity.raw_payload[sourceField]) !== null && finite(data[sourceField]) === null
      )
    );
    const prevCodes = Array.isArray(sameIdentity?.raw_payload?.__statement_coverage?.returned_metric_codes)
      ? sameIdentity.raw_payload.__statement_coverage.returned_metric_codes : [];
    const currCodeSet = new Set(Array.isArray(data.__statement_coverage?.returned_metric_codes)
      ? data.__statement_coverage.returned_metric_codes : []);
    const droppedCoverageMetrics = prevCodes.some(code => !currCodeSet.has(code));
    const preserveExistingNonNull = Boolean(sameIdentity && (isIncomplete || missingPreviouslyCollectedField || droppedCoverageMetrics));
    let reportPayload = data;
    if (preserveExistingNonNull && sameIdentity.source_version) {
      sourceVersion = sameIdentity.source_version;
      if (data.__statement_coverage && prevCodes.length) {
        reportPayload = {
          ...data,
          __statement_coverage: {
            ...data.__statement_coverage,
            returned_metric_codes: [...new Set([...prevCodes, ...currCodeSet])],
          },
        };
      }
    }
    let rawRecordId = null;
    if (options.runId && sourceId) {
      const rawKey = `${companyId}:${kind}:${asDate(data.end_date)}:${announced || ''}:${fAnnDate || ''}:${data.report_type || ''}:${data.update_flag || ''}`;
      const raw = (await client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
        DO UPDATE SET run_id=EXCLUDED.run_id
        RETURNING raw_record_id`,
      [options.runId, sourceId, `stock_financial_${kind}`, rawKey, fAnnDate || announced, JSON.stringify(rawData), hash(JSON.stringify(stablePayload(rawData)))]
      )).rows[0];
      rawRecordId = raw && raw.raw_record_id;
    }
    const report = (await client.query(`INSERT INTO fundamental.financial_reports(company_id,report_kind,period_end,period_type,announced_at,f_ann_date,report_type,comp_type,source_id,source_version,update_flag,raw_record_id,raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT(company_id,report_kind,period_end,source_id,source_version)
      DO UPDATE SET announced_at=COALESCE(EXCLUDED.announced_at,fundamental.financial_reports.announced_at),
        f_ann_date=COALESCE(EXCLUDED.f_ann_date,fundamental.financial_reports.f_ann_date),
        -- 报告期类型随重新采集更新：历史行曾按错误口径落成 other，不更新就永远取不到年度利润。
        period_type=EXCLUDED.period_type,
        report_type=COALESCE(NULLIF(EXCLUDED.report_type,''),fundamental.financial_reports.report_type),
        comp_type=COALESCE(NULLIF(EXCLUDED.comp_type,''),fundamental.financial_reports.comp_type),
        update_flag=COALESCE(NULLIF(EXCLUDED.update_flag,''),fundamental.financial_reports.update_flag),
        raw_record_id=COALESCE(EXCLUDED.raw_record_id,fundamental.financial_reports.raw_record_id),
        raw_payload=CASE
          WHEN ($14::boolean OR COALESCE((EXCLUDED.raw_payload->'__statement_coverage'->>'complete')::boolean, true) = false)
            AND COALESCE((fundamental.financial_reports.raw_payload->'__statement_coverage'->>'complete')::boolean, false) = true
          THEN CASE
            WHEN (fundamental.financial_reports.raw_payload ? '__statement_comparisons')
              OR (EXCLUDED.raw_payload ? '__statement_comparisons')
            THEN jsonb_set(
              fundamental.financial_reports.raw_payload || jsonb_strip_nulls(EXCLUDED.raw_payload)
                || jsonb_build_object('__statement_coverage', CASE
                  WHEN COALESCE((EXCLUDED.raw_payload->'__statement_coverage'->>'complete')::boolean, false) = true
                  THEN EXCLUDED.raw_payload->'__statement_coverage'
                  ELSE COALESCE(fundamental.financial_reports.raw_payload->'__statement_coverage', EXCLUDED.raw_payload->'__statement_coverage')
                END),
              '{__statement_comparisons}',
              jsonb_strip_nulls(jsonb_build_object(
                'yoy', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'yoy', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'yoy', '{}'::jsonb), '{}'::jsonb),
                'qoq', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'qoq', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'qoq', '{}'::jsonb), '{}'::jsonb),
                'single', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single', '{}'::jsonb), '{}'::jsonb),
                'single_yoy', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single_yoy', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single_yoy', '{}'::jsonb), '{}'::jsonb),
                'single_qoq', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single_qoq', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single_qoq', '{}'::jsonb), '{}'::jsonb)
              )),
              true
            )
            ELSE fundamental.financial_reports.raw_payload || jsonb_strip_nulls(EXCLUDED.raw_payload)
              || jsonb_build_object('__statement_coverage', CASE
                WHEN COALESCE((EXCLUDED.raw_payload->'__statement_coverage'->>'complete')::boolean, false) = true
                THEN EXCLUDED.raw_payload->'__statement_coverage'
                ELSE COALESCE(fundamental.financial_reports.raw_payload->'__statement_coverage', EXCLUDED.raw_payload->'__statement_coverage')
              END)
          END
          WHEN (fundamental.financial_reports.raw_payload ? '__statement_comparisons')
            OR (EXCLUDED.raw_payload ? '__statement_comparisons')
          THEN jsonb_set(
            EXCLUDED.raw_payload,
            '{__statement_comparisons}',
            jsonb_strip_nulls(jsonb_build_object(
              'yoy', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'yoy', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'yoy', '{}'::jsonb), '{}'::jsonb),
              'qoq', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'qoq', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'qoq', '{}'::jsonb), '{}'::jsonb),
              'single', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single', '{}'::jsonb), '{}'::jsonb),
              'single_yoy', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single_yoy', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single_yoy', '{}'::jsonb), '{}'::jsonb),
              'single_qoq', NULLIF(COALESCE(fundamental.financial_reports.raw_payload->'__statement_comparisons'->'single_qoq', '{}'::jsonb) || COALESCE(EXCLUDED.raw_payload->'__statement_comparisons'->'single_qoq', '{}'::jsonb), '{}'::jsonb)
            )),
            true
          )
          ELSE EXCLUDED.raw_payload
        END,ingested_at=now() RETURNING report_id`,
    [companyId, kind, asDate(data.end_date), rowPeriodType, announced, fAnnDate, String(data.report_type || ''), String(data.comp_type || ''), sourceId, sourceVersion, data.update_flag || '', rawRecordId, JSON.stringify(reportPayload), preserveExistingNonNull])).rows[0];
    await client.query(`UPDATE fundamental.financial_reports
      SET f_ann_date=COALESCE($2,f_ann_date),report_type=COALESCE(NULLIF($3,''),report_type),comp_type=COALESCE(NULLIF($4,''),comp_type),statement_scope=CASE WHEN $3='1' THEN 'consolidated' ELSE statement_scope END,
      raw_record_id=COALESCE($5,raw_record_id)
      WHERE report_id=$1`, [report.report_id, fAnnDate, String(data.report_type || ''), String(data.comp_type || ''), rawRecordId]);
    for (const [sourceField, metricCode] of Object.entries(FACT_MAP[kind] || {})) {
      const value = finite(data[sourceField]);
      if (value === null) continue;
      const unit = metricCode === 'interest_coverage' ? 'multiple' : /roe|roa/.test(metricCode) ? 'percent' : 'currency';
      await client.query(`INSERT INTO fundamental.financial_facts(report_id,statement_type,metric_code,numeric_value,unit_code,currency_code,source_field)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(report_id,metric_code) DO UPDATE SET numeric_value=EXCLUDED.numeric_value,unit_code=EXCLUDED.unit_code,currency_code=EXCLUDED.currency_code,source_field=EXCLUDED.source_field`, [report.report_id, kind, metricCode, value, unit, unit === 'currency' ? rowCurrency : null, sourceField]);
    }
    // 三表全量科目：写对应准则的宽表（A股 CAS / 港股 HKFRS）。
    // 标准 20 个科目仍写 financial_facts，下游读取口径不变；两者互不替代。
    if (statementMetrics) {
      await writeStatementWideRow(client, {
        reportId: report.report_id, companyId, market, kind,
        periodEnd: asDate(data.end_date), periodType: rowPeriodType, announcedAt: announced,
        currency: rowCurrency, sourceId, sourceVersion, rawRecordId, metrics: statementMetrics,
      });
    }
  }
  // is_current_version 仍是旧兼容字段，但不能再按公司全局排名：同一发行人可能同时有 A/H 报告，
  // 也可能有合并/母公司范围。新读取端按市场和范围独立选版；这里至少让兼容标记与同一市场、同一范围一致。
  await client.query(`WITH ranked AS (
      SELECT report_id,row_number() OVER(
        PARTITION BY company_id,report_kind,period_end,
          COALESCE(statement_scope,'consolidated'),
          CASE
            WHEN upper(COALESCE(raw_payload->>'ts_code','')) LIKE '%.HK' THEN 'HK'
            WHEN upper(COALESCE(raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' THEN 'CN'
            ELSE 'UNKNOWN'
          END
        ORDER BY CASE WHEN COALESCE((raw_payload->'__statement_coverage'->>'complete')::boolean, true) THEN 0 ELSE 1 END,
          CASE WHEN report_type='1' THEN 0 ELSE 1 END,
          announced_at DESC NULLS LAST,ingested_at DESC,report_id DESC
      ) rn
      FROM fundamental.financial_reports
      WHERE company_id=$1 AND report_kind=$2
    )
    UPDATE fundamental.financial_reports r
       SET is_current_version=(ranked.rn=1)
      FROM ranked
     WHERE r.report_id=ranked.report_id`, [companyId, kind]);
}

function officialDividendSourceKey(row, fallbackCode = '') {
  const code = row.ts_code || fallbackCode || '';
  const period = asDate(row.end_date) || row.end_date || '';
  const ann = asDate(row.ann_date || row.imp_ann_date) || row.ann_date || '';
  const exDate = asDate(row.ex_date);
  const payDate = asDate(row.pay_date);
  const recordDate = asDate(row.record_date);
  const eventDate = exDate || (payDate && recordDate ? `${payDate}:${recordDate}` : (payDate || recordDate || ''));
  return `${code}:${period}:${ann}:${eventDate}`;
}

function legacyOfficialDividendSourceKeys(row = {}, fallbackId = '', fallbackCode = '') {
  const codes = [...new Set([row.ts_code, fallbackCode, fallbackId != null && fallbackId !== '' ? String(fallbackId) : ''].filter(Boolean))];
  const isoPeriod = asDate(row.end_date);
  const periods = [...new Set([row.end_date, isoPeriod, isoPeriod ? isoPeriod.replace(/-/g, '') : ''].filter(Boolean))];
  const isoAnn = asDate(row.ann_date || row.imp_ann_date);
  const anns = [...new Set([row.ann_date, row.imp_ann_date, isoAnn, isoAnn ? isoAnn.replace(/-/g, '') : '', ''].map(v => v || ''))];
  const exDate = asDate(row.ex_date);
  const payDate = asDate(row.pay_date);
  const recordDate = asDate(row.record_date);
  const fallbackEventDates = exDate
    ? [...new Set([payDate && recordDate ? `${payDate}:${recordDate}` : '', payDate, recordDate].filter(Boolean))]
    : (payDate ? [...new Set([payDate, recordDate].filter(Boolean))] : []);
  const keys = [];
  for (const code of codes) {
    for (const period of periods) {
      for (const ann of anns) {
        keys.push(`${code}:${period}:${ann}`);
        for (const evDate of fallbackEventDates) keys.push(`${code}:${period}:${ann}:${evDate}`);
      }
    }
  }
  return [...new Set(keys)];
}

async function resolveAndUpgradeDividendSourceKey(client, { instrumentId, sourceId, newKey, legacyKeys, protectedKeys, batchPeers, fiscalPeriodEnd, announcedAt, exDate, payDate, recordDate, totalAmount, cashPerShare }) {
  if (!instrumentId || !sourceId || !newKey) return { effectiveKey: newKey, skipWrite: false };
  const protectedList = Array.isArray(protectedKeys) ? protectedKeys.filter(k => k && k !== newKey) : [];
  // 1. 迟到/部分回包（如已有除净日后仅返回付款日或登记日）：
  //    只有无日期冲突且能唯一锁定到一条已确认事件时才复用其更精确键；
  //    同一批次内其他事件的键不得被复用或改写；命中多条候选时先按金额消歧，仍不唯一则跳过覆盖。
  if (!exDate && (payDate || recordDate)) {
    const candidates = (await client.query(
      `SELECT source_key, total_cash_amount
         FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND action_type='dividend' AND source_id=$2
          AND fiscal_period_end IS NOT DISTINCT FROM $6::date
          AND announced_at IS NOT DISTINCT FROM $7::date
          AND NOT (source_key = ANY($8::text[]))
          AND ($3::date IS NULL OR ex_date IS NULL OR ex_date = $3::date)
          AND ($4::date IS NULL OR pay_date IS NULL OR pay_date = $4::date)
          AND ($5::date IS NULL OR record_date IS NULL OR record_date = $5::date)
          AND (($3::date IS NOT NULL AND ex_date = $3::date)
            OR ($4::date IS NOT NULL AND pay_date = $4::date)
            OR ($5::date IS NOT NULL AND record_date = $5::date))
          AND (ex_date IS NOT NULL
            OR ($4::date IS NULL AND pay_date IS NOT NULL)
            OR ($5::date IS NULL AND pay_date IS NOT NULL AND record_date IS NOT NULL))
        ORDER BY (ex_date IS NOT NULL) DESC, (pay_date IS NOT NULL) DESC, action_id ASC`,
      [instrumentId, sourceId, exDate || null, payDate || null, recordDate || null, fiscalPeriodEnd || null, announcedAt || null, protectedList],
    )).rows;
    if (candidates.length === 1) {
      return { effectiveKey: candidates[0].source_key, skipWrite: false };
    }
    if (candidates.length > 1) {
      const amountMatched = totalAmount != null
        ? candidates.filter(c => c.total_cash_amount != null && Math.abs(Number(c.total_cash_amount) - Number(totalAmount)) < 1e-6)
        : [];
      if (amountMatched.length === 1) {
        return { effectiveKey: amountMatched[0].source_key, skipWrite: false };
      }
      return { effectiveKey: null, skipWrite: true };
    }
  }
  const legacyList = (Array.isArray(legacyKeys) ? legacyKeys : []).filter(k => k !== newKey && !protectedList.includes(k));
  if (exDate && payDate && !recordDate) {
    const partialCandidates = (await client.query(
      `SELECT action_id, total_cash_amount, cash_per_share_pre_tax, to_char(record_date,'YYYY-MM-DD') AS record_date_iso
         FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND action_type='dividend' AND source_id=$2
          AND fiscal_period_end IS NOT DISTINCT FROM $3::date
          AND announced_at IS NOT DISTINCT FROM $4::date
          AND ex_date IS NULL AND pay_date = $5::date
          AND source_key <> $6
          AND NOT (source_key = ANY($7::text[]))
        ORDER BY record_date ASC NULLS LAST, action_id ASC`,
      [instrumentId, sourceId, fiscalPeriodEnd || null, announcedAt || null, payDate, newKey, protectedList],
    )).rows;
    const eqNum = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-6;
    const neqNum = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) >= 1e-6;
    const conflictsCandidate = (c, amt, cps) => neqNum(c.total_cash_amount, amt) || neqNum(c.cash_per_share_pre_tax, cps);
    const sameEconomics = (c, amt, cps) => !conflictsCandidate(c, amt, cps)
      && (eqNum(c.total_cash_amount, amt) || eqNum(c.cash_per_share_pre_tax, cps));
    const matchScore = (c, amt, cps) => {
      if (conflictsCandidate(c, amt, cps)) return -1;
      return (eqNum(c.total_cash_amount, amt) ? 1 : 0) + (eqNum(c.cash_per_share_pre_tax, cps) ? 1 : 0);
    };
    const sameGroupPeers = (Array.isArray(batchPeers) ? batchPeers : []).filter(peer =>
      peer.key !== newKey
      && peer.endDate === (fiscalPeriodEnd || null)
      && peer.annDate === (announcedAt || null)
      && peer.payDate === (payDate || null));
    let matched = [];
    if (partialCandidates.length === 1 && !sameGroupPeers.length) {
      matched = partialCandidates;
    } else if (partialCandidates.length) {
      const econCandidates = partialCandidates.filter(c => sameEconomics(c, totalAmount, cashPerShare));
      if (econCandidates.length) {
        const myScore = matchScore(econCandidates[0], totalAmount, cashPerShare);
        const peerClaimedElsewhere = peer => partialCandidates.some(other =>
          !econCandidates.some(ec => ec.action_id === other.action_id)
          && matchScore(other, peer.totalAmount, peer.cashPerShare) > matchScore(econCandidates[0], peer.totalAmount, peer.cashPerShare),
        );
        const activePeers = sameGroupPeers.filter(p => !peerClaimedElsewhere(p));
        const tiedPeers = activePeers.filter(p => matchScore(econCandidates[0], p.totalAmount, p.cashPerShare) === myScore);
        const betterPeers = activePeers.filter(p => matchScore(econCandidates[0], p.totalAmount, p.cashPerShare) > myScore);
        if (!betterPeers.length && myScore > 0) {
          if (!tiedPeers.length) {
            matched = [econCandidates[0]];
          } else {
            const allTied = [
              { key: newKey, exDate },
              ...tiedPeers.map(p => ({ key: p.key, exDate: p.exDate || '' })),
            ].sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)) || String(a.key).localeCompare(String(b.key)));
            const existingTiedKeys = new Set(
              (await client.query(
                `SELECT source_key FROM fundamental.corporate_actions
                  WHERE source_id=$1 AND source_key = ANY($2::text[]) AND ex_date IS NOT NULL`,
                [sourceId, allTied.map(t => t.key)],
              )).rows.map(r => r.source_key),
            );
            const remainingTied = allTied.filter(t => !existingTiedKeys.has(t.key));
            const myRank = remainingTied.findIndex(t => t.key === newKey);
            if (myRank >= 0 && myRank < econCandidates.length) {
              matched = [econCandidates[myRank]];
            }
          }
        }
      }
    }
    if (matched.length === 1) {
      const existingKeep = (await client.query(
        `SELECT action_id, to_char(record_date,'YYYY-MM-DD') AS record_date_iso, total_cash_amount, cash_per_share_pre_tax
           FROM fundamental.corporate_actions
          WHERE source_id=$1 AND source_key=$2 LIMIT 1`,
        [sourceId, newKey],
      )).rows[0];
      if (!existingKeep) {
        const upgraded = await client.query(
          `WITH locked AS (
             SELECT action_id FROM fundamental.corporate_actions
              WHERE action_id=$2 AND ex_date IS NULL AND pay_date = $3::date
              FOR UPDATE
           )
           UPDATE fundamental.corporate_actions ca
              SET source_key=$1
             FROM locked
            WHERE ca.action_id = locked.action_id
              AND NOT EXISTS (
                SELECT 1 FROM fundamental.corporate_actions dup
                 WHERE dup.source_id=$4 AND dup.source_key=$1
              )`,
          [newKey, matched[0].action_id, payDate, sourceId],
        );
        if (upgraded.rowCount > 0) return { effectiveKey: newKey, skipWrite: false };
      }
      const keepRow = existingKeep || (await client.query(
        `SELECT action_id, to_char(record_date,'YYYY-MM-DD') AS record_date_iso, total_cash_amount, cash_per_share_pre_tax
           FROM fundamental.corporate_actions
          WHERE source_id=$1 AND source_key=$2 LIMIT 1`,
        [sourceId, newKey],
      )).rows[0];
      const bothHaveSameRecordDate = Boolean(
        keepRow && keepRow.record_date_iso && matched[0].record_date_iso
        && keepRow.record_date_iso === matched[0].record_date_iso,
      );
      const recordDateConsistent = Boolean(
        keepRow
        && (!recordDate || !matched[0].record_date_iso || recordDate === matched[0].record_date_iso)
        && (!keepRow.record_date_iso || !matched[0].record_date_iso
          || keepRow.record_date_iso === matched[0].record_date_iso),
      );
      const sameAsKeep = Boolean(
        keepRow && recordDateConsistent
        && (bothHaveSameRecordDate || (
          !conflictsCandidate(matched[0], keepRow.total_cash_amount, keepRow.cash_per_share_pre_tax)
          && !conflictsCandidate(matched[0], totalAmount, cashPerShare)
        )),
      );
      if (sameAsKeep) {
        await client.query(
          `WITH del AS (
             DELETE FROM fundamental.corporate_actions
              WHERE action_id=$2 AND ex_date IS NULL AND pay_date = $3::date
                AND EXISTS (
                  SELECT 1 FROM fundamental.corporate_actions keep
                   WHERE keep.source_id=$4 AND keep.source_key=$1
                )
              RETURNING record_date, cash_per_share_pre_tax, total_cash_amount, raw_payload
           )
           UPDATE fundamental.corporate_actions keep
              SET record_date=COALESCE(keep.record_date, del.record_date),
                  cash_per_share_pre_tax=COALESCE(keep.cash_per_share_pre_tax, del.cash_per_share_pre_tax),
                  total_cash_amount=COALESCE(keep.total_cash_amount, del.total_cash_amount),
                  raw_payload=COALESCE(jsonb_strip_nulls(del.raw_payload), '{}'::jsonb)
                    || COALESCE(jsonb_strip_nulls(keep.raw_payload), '{}'::jsonb)
                    || jsonb_strip_nulls(jsonb_build_object(
                      'record_date', to_char(COALESCE(keep.record_date, del.record_date), 'YYYY-MM-DD'),
                      'cash_div_tax', COALESCE(keep.cash_per_share_pre_tax, del.cash_per_share_pre_tax),
                      'total_cash_amount', COALESCE(keep.total_cash_amount, del.total_cash_amount)
                    ))
             FROM del
            WHERE keep.source_id=$4 AND keep.source_key=$1`,
          [newKey, matched[0].action_id, payDate, sourceId],
        );
      }
      return { effectiveKey: newKey, skipWrite: false };
    }
  }
  if (!legacyList.length) return { effectiveKey: newKey, skipWrite: false };
  // 2. 补齐更精确日期（如登记日→付款日、付款日→付款日+登记日、付款日/登记日→除净日、旧3段键→新4段键）：单条加锁原子升级。
  await client.query(
    `WITH locked AS (
       SELECT action_id
         FROM fundamental.corporate_actions
        WHERE instrument_id=$2 AND action_type='dividend' AND source_id=$3
          AND source_key = ANY($4::text[])
          AND (($5::date IS NOT NULL AND ex_date = $5::date)
            OR (ex_date IS NULL
                AND (($5::date IS NOT NULL AND pay_date IS NOT DISTINCT FROM $6::date AND ($7::date IS NULL OR record_date IS NULL OR record_date = $7::date))
                  OR ($6::date IS NOT NULL AND pay_date IS NULL AND record_date = $7::date)
                  OR ($5::date IS NULL AND pay_date IS NOT NULL AND pay_date = $6::date AND ($7::date IS NULL OR record_date IS NULL OR record_date = $7::date)))))
        ORDER BY (ex_date IS NOT NULL) DESC, (pay_date IS NOT NULL) DESC, action_id ASC
        LIMIT 1
        FOR UPDATE
     )
     UPDATE fundamental.corporate_actions ca
        SET source_key=$1
       FROM locked
      WHERE ca.action_id = locked.action_id
        AND NOT EXISTS (
          SELECT 1 FROM fundamental.corporate_actions dup
           WHERE dup.source_id=$3 AND dup.source_key=$1
        )`,
    [newKey, instrumentId, sourceId, legacyList, exDate || null, payDate || null, recordDate || null],
  );
  await client.query(
    `DELETE FROM fundamental.corporate_actions
      WHERE instrument_id=$1 AND action_type='dividend' AND source_id=$2
        AND source_key = ANY($3::text[])
        AND (($4::date IS NOT NULL AND ex_date = $4::date)
          OR (ex_date IS NULL
              AND (($4::date IS NOT NULL AND pay_date IS NOT DISTINCT FROM $5::date AND ($6::date IS NULL OR record_date IS NULL OR record_date = $6::date))
                OR ($5::date IS NOT NULL AND pay_date IS NULL AND record_date = $6::date)
                OR ($4::date IS NULL AND pay_date IS NOT NULL AND pay_date = $5::date AND ($6::date IS NULL OR record_date IS NULL OR record_date = $6::date)))))
        AND EXISTS (
          SELECT 1 FROM fundamental.corporate_actions keep
           WHERE keep.source_id=$2 AND keep.source_key=$7
        )`,
    [instrumentId, sourceId, legacyList, exDate || null, payDate || null, recordDate || null, newKey],
  );
  return { effectiveKey: newKey, skipWrite: false };
}

function orderDividendBatchForUpsert(rows = []) {
  return [...rows].sort((a, b) => {
    const score = row => (!asDate(row && row.ex_date) ? 0 : (asDate(row && row.record_date) ? 1 : 2));
    return score(a) - score(b);
  });
}

function dividendBatchPeersOf(rows = [], fallbackCode = '') {
  return (rows || []).filter(r => r && r.end_date).map(r => {
    const cashPre = finite(r.cash_div_tax);
    const base = finite(r.base_share);
    const declaredTotal = finite(r.total_cash_amount);
    const totalAmount = declaredTotal != null ? declaredTotal
      : (cashPre != null && base != null ? cashPre * base * 10000 : null);
    return {
      key: officialDividendSourceKey(r, fallbackCode),
      endDate: asDate(r.end_date),
      annDate: asDate(r.ann_date || r.imp_ann_date),
      payDate: asDate(r.pay_date),
      exDate: asDate(r.ex_date),
      totalAmount,
      cashPerShare: cashPre,
    };
  });
}

// formulaVersion 由编排层传入，仓储不依赖 services 常量模块。
// 理杏仁官方分红 → 标准分红事实（fundamental.corporate_actions），来源写 lixinger_official。
// 只写事实、不动 legacy stock_dividends；同一事件与 Tushare 行并存，由现金收益按来源层级与事件键去重择一。
async function syncOfficialDividends(client, instrumentId, sourceId, rows) {
  let written = 0;
  const orderedRows = orderDividendBatchForUpsert(rows || []);
  const batchPeers = dividendBatchPeersOf(orderedRows, instrumentId);
  const batchKeys = [...new Set(batchPeers.map(p => p.key))];
  for (const row of orderedRows) {
    if (!row || !row.end_date) continue;
    const cashPre = finite(row.cash_div_tax);
    const base = finite(row.base_share);
    // 分红总额优先用来源直接给的金额（R2-03）：缺少 base_share 时不能把总额算成 null，
    // 年度异常与股息率都要用它做"已实施现金"。
    const declaredTotal = finite(row.total_cash_amount);
    const amount = declaredTotal != null ? declaredTotal
      : (cashPre != null && base != null ? cashPre * base * 10000 : null);
    const newKey = officialDividendSourceKey(row, instrumentId);
    const { effectiveKey, skipWrite } = await resolveAndUpgradeDividendSourceKey(client, {
      instrumentId,
      sourceId,
      newKey,
      legacyKeys: legacyOfficialDividendSourceKeys(row, instrumentId),
      protectedKeys: batchKeys,
      batchPeers,
      fiscalPeriodEnd: asDate(row.end_date),
      announcedAt: asDate(row.ann_date),
      exDate: asDate(row.ex_date),
      payDate: asDate(row.pay_date),
      recordDate: asDate(row.record_date),
      totalAmount: amount,
      cashPerShare: cashPre,
    });
    if (effectiveKey && !batchKeys.includes(effectiveKey)) batchKeys.push(effectiveKey);
    if (skipWrite) {
      written += 1;
      continue;
    }
    await client.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload)
      VALUES($1,'dividend',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
      ON CONFLICT(source_id,source_key) DO UPDATE SET
        status=COALESCE(NULLIF(EXCLUDED.status,''),fundamental.corporate_actions.status),
        record_date=COALESCE(EXCLUDED.record_date,fundamental.corporate_actions.record_date),
        ex_date=COALESCE(EXCLUDED.ex_date,fundamental.corporate_actions.ex_date),
        pay_date=COALESCE(EXCLUDED.pay_date,fundamental.corporate_actions.pay_date),
        cash_per_share_pre_tax=COALESCE(EXCLUDED.cash_per_share_pre_tax,fundamental.corporate_actions.cash_per_share_pre_tax),
        cash_per_share_after_tax=COALESCE(EXCLUDED.cash_per_share_after_tax,fundamental.corporate_actions.cash_per_share_after_tax),
        stock_dividend_ratio=COALESCE(EXCLUDED.stock_dividend_ratio,fundamental.corporate_actions.stock_dividend_ratio),
        capitalization_ratio=COALESCE(EXCLUDED.capitalization_ratio,fundamental.corporate_actions.capitalization_ratio),
        base_shares=COALESCE(EXCLUDED.base_shares,fundamental.corporate_actions.base_shares),
        total_cash_amount=COALESCE(EXCLUDED.total_cash_amount,fundamental.corporate_actions.total_cash_amount),
        currency_code=COALESCE(NULLIF(EXCLUDED.currency_code,''),fundamental.corporate_actions.currency_code),
        raw_payload=COALESCE(fundamental.corporate_actions.raw_payload,'{}'::jsonb)||jsonb_strip_nulls(EXCLUDED.raw_payload),
        ingested_at=now()`,
    [instrumentId, asDate(row.end_date), asDate(row.ann_date), asDate(row.record_date), asDate(row.ex_date), asDate(row.pay_date),
      row.div_proc || '', cashPre, null, finite(row.stk_bo_rate), finite(row.stk_co_rate), base == null ? null : base * 10000, amount,
      String(row.currency || 'CNY').toUpperCase(),
      sourceId, effectiveKey, JSON.stringify(row)]);
    written += 1;
  }
  return written;
}

// 按行自带的 source_code 写标准分红事实：服务层只给证券代码和行，
// 证券标识与来源标识的解析都留在这里，服务不需要知道来源是谁。
async function syncSourcedDividendFacts(tsCode, rows, client = null) {
  if (!rows || !rows.length) return 0;
  const db = client || require('../db/connection').pool;
  const [inst, sources] = await Promise.all([
    db.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [tsCode]),
    db.query('SELECT source_code,source_id FROM ops.data_sources'),
  ]);
  const instrumentId = inst.rows[0] && inst.rows[0].instrument_id;
  if (!instrumentId) return 0;
  const sourceIdByCode = new Map(sources.rows.map(row => [row.source_code, row.source_id]));
  const groups = new Map();
  for (const row of rows) {
    const code = row.source_code || 'tushare';
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  }
  let written = 0;
  for (const [code, group] of groups) {
    const sourceId = sourceIdByCode.get(code);
    if (!sourceId) continue;
    written += await syncOfficialDividends(db, instrumentId, sourceId, group);
  }
  return written;
}

async function syncAnalytics(client, instrumentId, analysis, sources, formulaVersion) {
  if (!analysis) return;
  for (const [code, [name, category, unit]] of Object.entries(METRICS)) {
    await client.query(`INSERT INTO analytics.metric_definitions(metric_code,metric_name,category,unit_code,formula_version) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(metric_code) DO UPDATE SET metric_name=EXCLUDED.metric_name,category=EXCLUDED.category,unit_code=EXCLUDED.unit_code,formula_version=EXCLUDED.formula_version,updated_at=now()`, [code, name, category, unit, '1']);
  }
  const asOf = asDate(analysis.as_of) || new Date().toISOString().slice(0, 10), valuation = analysis.valuation || {}, metricValues = analysisMetricValues(analysis);
  for (const code of Object.keys(METRICS)) {
    const value = finite(metricValues[code]), calculated = code === 'roa' && String(valuation.roa_source || '').includes('补算');
    await client.query(`INSERT INTO analytics.metric_values(instrument_id,metric_code,as_of_date,numeric_value,status,formula_version,input_hash,diagnostics)
      VALUES($1,$2,$3,$4,$5,'1',$6,$7::jsonb) ON CONFLICT(instrument_id,metric_code,as_of_date,period_start,period_end,formula_version)
      DO UPDATE SET numeric_value=EXCLUDED.numeric_value,status=EXCLUDED.status,input_hash=EXCLUDED.input_hash,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`, [instrumentId, code, asOf, value, value == null ? 'missing' : calculated ? 'calculated' : 'valid', hash(JSON.stringify(metricValues)), JSON.stringify(code === 'roa' ? { source: valuation.roa_source || '' } : {})]);
  }
  for (const code of ['price', 'pe', 'pb']) {
    const stat = analysis.percentiles && analysis.percentiles[code];
    if (!stat) continue;
    await client.query(`INSERT INTO analytics.metric_statistics(instrument_id,metric_code,as_of_date,window_start,window_end,percentile_value,valid_samples,excluded_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(instrument_id,metric_code,as_of_date,window_start,window_end) DO UPDATE SET percentile_value=EXCLUDED.percentile_value,valid_samples=EXCLUDED.valid_samples,excluded_reason=EXCLUDED.excluded_reason,calculated_at=now()`, [instrumentId, code, asOf, analysis.percentiles.window_start ? asDate(analysis.percentiles.window_start) : null, asOf, finite(stat.value), Number(stat.samples || 0), stat.reason || '']);
  }
  const controller = analysis.actual_controller || {}, report = analysis.latest_report || {}, guidance = analysis.performance_forecast || {}, quote = analysis.quote || {};
  const dividendHistory = (analysis.stability && analysis.stability.dividend_history) || [];
  const latestDividend = dividendHistory[0] || {};
  const latestEventDate = (analysis.events || []).reduce((max, e) => String(e.event_date || '') > max ? String(e.event_date) : max, '');
  const stockWatermark = {
    analysis_type: 'stock',
    as_of: asDate(analysis.as_of),
    latest_report_end: report.end_date || null,
    instrument: { name: analysis.name || '', list_date: asDate(analysis.list_date) },
    market: { trade_date: asDate(analysis.latest_market_trade_date), quote_time: quote.quote_time || null, quote_source: quote.source || null },
    financial: { report_end_date: report.end_date || null, report_ann_date: report.ann_date || null },
    dividend: { latest_ann_date: latestDividend.ann_date || null, latest_ex_date: latestDividend.ex_date || null },
    guidance: { ann_date: guidance.ann_date || null, end_date: guidance.end_date || null },
    industry: {
      name: (analysis.industry_info && analysis.industry_info.name) || analysis.industry || '',
      system: (analysis.industry_info && analysis.industry_info.system) || '',
    },
    controller: { name: controller.name || '', source: controller.source || '' },
    event: { latest_event_date: latestEventDate || null },
    formula_bundle_version: formulaVersion,
  };
  await client.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
    VALUES($1,$2,'stock_analysis',$3,$4::jsonb,$5::jsonb) ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,source_watermark=EXCLUDED.source_watermark,created_at=now()`, [instrumentId, asOf, formulaVersion, JSON.stringify(analysis), JSON.stringify(stockWatermark)]);
  if (finite(quote.price) !== null) {
    await client.query(`INSERT INTO market.latest_quotes(instrument_id,source_id,price,currency_code,quote_time,is_stale)
      VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(instrument_id,source_id) DO UPDATE SET price=EXCLUDED.price,currency_code=EXCLUDED.currency_code,quote_time=EXCLUDED.quote_time,is_stale=false,fetched_at=now()`, [instrumentId, sources[quote.source] || sources.calculated, finite(quote.price), quote.currency || 'CNY', quote.quote_time || null]);
  }
  await client.query(`INSERT INTO analytics.stock_overview_latest(instrument_id,as_of_date,name,canonical_code,industry_label,currency_code,price,total_market_cap,a_share_market_cap,circulating_market_cap,free_float_market_cap,controller_name,controller_type,latest_report_date,latest_report_announced_at,guidance_summary,metrics)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT(instrument_id) DO UPDATE SET as_of_date=EXCLUDED.as_of_date,name=EXCLUDED.name,industry_label=EXCLUDED.industry_label,currency_code=EXCLUDED.currency_code,price=EXCLUDED.price,total_market_cap=EXCLUDED.total_market_cap,a_share_market_cap=EXCLUDED.a_share_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,free_float_market_cap=EXCLUDED.free_float_market_cap,controller_name=EXCLUDED.controller_name,controller_type=EXCLUDED.controller_type,latest_report_date=EXCLUDED.latest_report_date,latest_report_announced_at=EXCLUDED.latest_report_announced_at,guidance_summary=EXCLUDED.guidance_summary,metrics=EXCLUDED.metrics,updated_at=now()`,
  [instrumentId, asOf, analysis.name || analysis.ts_code, analysis.ts_code, (analysis.industry_info && analysis.industry_info.name) || analysis.industry || '', quote.currency || 'CNY', finite(quote.price), finite(valuation.market_cap), finite(valuation.a_share_market_cap), finite(valuation.circulating_market_cap), finite(valuation.free_float_market_cap), controller.name || '', controller.type || '', asDate(report.end_date), asDate(report.ann_date), guidance.summary || guidance.type || '', JSON.stringify(valuation)]);
}

async function syncQualityIssues(client, instrumentId, companyId, analysis) {
  if (!analysis) return;
  const valuation = analysis.valuation || {};
  const issues = [];
  if (finite(valuation.circulating_market_cap) === null) issues.push(['daily_basic', 'circulating_market_cap', 'missing_value']);
  if (finite(valuation.free_float_market_cap) === null) issues.push(['daily_basic', 'free_float_market_cap', 'missing_value']);
  if (String(valuation.roa_source || '').includes('补算')) issues.push(['fina_indicator', 'roa', 'calculated_fallback']);
  for (const [dataset, field, type] of issues) {
    await client.query(`INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
      DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`, [instrumentId, companyId, dataset, field, type, JSON.stringify({ ts_code: analysis.ts_code || '' })]);
  }
}

// ---- 以下为批次1按 method(params, tx) 登记的新仓储方法 ----

async function createIngestionRun(params, tx) {
  const { rows } = await tx.query(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status) VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
    [params.sourceId, params.datasetCode, JSON.stringify(params.requestRange || {})],
  );
  return rows[0].run_id;
}

async function finishIngestionRun(params, tx) {
  await tx.query(
    `UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`,
    [params.runId, params.rowCount || 0],
  );
}

async function insertRawRecord(params, tx) {
  await tx.query(
    `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
     VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
    [params.runId, params.sourceId, params.datasetCode, params.sourceKey, JSON.stringify(params.payload), params.payloadHash],
  );
}

async function upsertDailyBar(params, tx) {
  await tx.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close) VALUES($1,$2,$3,$4)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET close=EXCLUDED.close,ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.close],
  );
}

async function upsertAdjustmentFactor(params, tx) {
  await tx.query(
    `INSERT INTO market.adjustment_factors(instrument_id,trade_date,source_id,adj_factor) VALUES($1,$2,$3,$4)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET adj_factor=EXCLUDED.adj_factor,ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.adjFactor],
  );
}

async function upsertDailyValuation(params, tx) {
  await tx.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap,free_float_market_cap,currency_code)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(instrument_id,trade_date,source_id)
     DO UPDATE SET pe_static=COALESCE(EXCLUDED.pe_static,market.daily_valuations.pe_static),
       pe_ttm=COALESCE(EXCLUDED.pe_ttm,market.daily_valuations.pe_ttm),
       pb=COALESCE(EXCLUDED.pb,market.daily_valuations.pb),
       dividend_yield_ttm=COALESCE(EXCLUDED.dividend_yield_ttm,market.daily_valuations.dividend_yield_ttm),
       total_market_cap=COALESCE(EXCLUDED.total_market_cap,market.daily_valuations.total_market_cap),
       circulating_market_cap=COALESCE(EXCLUDED.circulating_market_cap,market.daily_valuations.circulating_market_cap),
       free_float_market_cap=COALESCE(EXCLUDED.free_float_market_cap,market.daily_valuations.free_float_market_cap),
       ingested_at=now()`,
    [params.instrumentId, params.tradeDate, params.sourceId, params.peStatic, params.peTtm, params.pb, params.dividendYield,
      params.totalMarketCap, params.circulatingMarketCap, params.freeFloatMarketCap, params.currencyCode],
  );
}

async function upsertShareCapital(params, tx) {
  await tx.query(
    `INSERT INTO market.share_capital_history(instrument_id,effective_date,source_id,total_shares,a_shares,circulating_shares,free_float_shares)
     VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT(instrument_id,effective_date,source_id)
     DO UPDATE SET total_shares=EXCLUDED.total_shares,a_shares=EXCLUDED.a_shares,circulating_shares=EXCLUDED.circulating_shares,free_float_shares=EXCLUDED.free_float_shares,ingested_at=now()`,
    [params.instrumentId, params.effectiveDate, params.sourceId, params.totalShares, params.circulatingShares, params.freeFloatShares],
  );
}

async function upsertCorporateAction(params, tx) {
  let effectiveKey = params.sourceKey;
  if (Array.isArray(params.legacySourceKeys) && params.legacySourceKeys.length) {
    const resolved = await resolveAndUpgradeDividendSourceKey(tx, {
      instrumentId: params.instrumentId,
      sourceId: params.sourceId,
      newKey: params.sourceKey,
      legacyKeys: params.legacySourceKeys,
      protectedKeys: params.protectedSourceKeys,
      batchPeers: params.batchPeers,
      fiscalPeriodEnd: params.fiscalPeriodEnd,
      announcedAt: params.announcedAt,
      exDate: params.exDate,
      payDate: params.payDate,
      recordDate: params.recordDate,
      totalAmount: params.totalCashAmount,
      cashPerShare: params.cashPerSharePreTax,
    });
    if (resolved.skipWrite) return null;
    effectiveKey = resolved.effectiveKey;
  }
  await tx.query(
    `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload)
     VALUES($1,'dividend',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET
       status=COALESCE(NULLIF(EXCLUDED.status,''),fundamental.corporate_actions.status),
       record_date=COALESCE(EXCLUDED.record_date,fundamental.corporate_actions.record_date),
       ex_date=COALESCE(EXCLUDED.ex_date,fundamental.corporate_actions.ex_date),
       pay_date=COALESCE(EXCLUDED.pay_date,fundamental.corporate_actions.pay_date),
       cash_per_share_pre_tax=COALESCE(EXCLUDED.cash_per_share_pre_tax,fundamental.corporate_actions.cash_per_share_pre_tax),
       cash_per_share_after_tax=COALESCE(EXCLUDED.cash_per_share_after_tax,fundamental.corporate_actions.cash_per_share_after_tax),
       stock_dividend_ratio=COALESCE(EXCLUDED.stock_dividend_ratio,fundamental.corporate_actions.stock_dividend_ratio),
       capitalization_ratio=COALESCE(EXCLUDED.capitalization_ratio,fundamental.corporate_actions.capitalization_ratio),
       base_shares=COALESCE(EXCLUDED.base_shares,fundamental.corporate_actions.base_shares),
       total_cash_amount=COALESCE(EXCLUDED.total_cash_amount,fundamental.corporate_actions.total_cash_amount),
       currency_code=COALESCE(NULLIF(EXCLUDED.currency_code,''),fundamental.corporate_actions.currency_code),
       raw_payload=COALESCE(fundamental.corporate_actions.raw_payload,'{}'::jsonb)||jsonb_strip_nulls(EXCLUDED.raw_payload),
       ingested_at=now()`,
    [params.instrumentId, params.fiscalPeriodEnd, params.announcedAt, params.recordDate, params.exDate, params.payDate, params.status,
      params.cashPerSharePreTax, params.cashPerShareAfterTax, params.stockDividendRatio, params.capitalizationRatio,
      params.baseShares, params.totalCashAmount, params.currencyCode || 'CNY', params.sourceId, effectiveKey, JSON.stringify(params.rawPayload || {})],
  );
  return effectiveKey;
}

async function upsertEarningsGuidance(params, tx) {
  await tx.query(
    `INSERT INTO fundamental.earnings_guidance(company_id,period_end,guidance_type,announced_at,profit_min,profit_max,change_min,change_max,summary,change_reason,currency_code,source_id,source_key,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [params.companyId, params.periodEnd, params.guidanceType, params.announcedAt, params.profitMin, params.profitMax,
      params.changeMin, params.changeMax, params.summary, params.changeReason, params.sourceId, params.sourceKey, JSON.stringify(params.rawPayload || {})],
  );
}

async function upsertFinancialCursor(params, tx) {
  await tx.query(
    `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
     VALUES($1,$2,$3,'financial',CURRENT_DATE,now(),'') ON CONFLICT(scope_key,dataset_code)
     DO UPDATE SET last_success_date=CURRENT_DATE,last_attempt_at=now(),last_error='',updated_at=now()`,
    [params.instrumentId, params.companyId, `${params.instrumentId}:${params.companyId}`],
  );
}

async function insertQualityIssue(params, tx) {
  await tx.query(
    `INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,details)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
     DO UPDATE SET details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`,
    [params.instrumentId, params.companyId, params.datasetCode, params.fieldCode, params.issueType, JSON.stringify(params.details || {})],
  );
}

async function upsertDocument(params, tx) {
  const { rows } = await tx.query(
    `INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(source_id,url,content_hash)
     DO UPDATE SET title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,raw_payload=event.documents.raw_payload || EXCLUDED.raw_payload RETURNING document_id`,
    [params.companyId, params.documentType, params.title, params.announcedAt, params.url, params.sourceId, params.contentHash, JSON.stringify(params.rawPayload || {})],
  );
  return rows[0] ? rows[0].document_id : null;
}

async function upsertCompanyEvent(params, tx) {
  await tx.query(
    `INSERT INTO event.company_events(company_id,event_type,event_date,title,importance,is_official,source_id,document_id,source_key,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(source_id,source_key)
     DO UPDATE SET event_date=EXCLUDED.event_date,title=EXCLUDED.title,event_type=EXCLUDED.event_type,importance=EXCLUDED.importance,is_official=EXCLUDED.is_official,document_id=EXCLUDED.document_id,details=EXCLUDED.details`,
    [params.companyId, params.eventType, params.eventDate, params.title, params.importance, params.isOfficial,
      params.sourceId, params.documentId, params.sourceKey, JSON.stringify(params.details || {})],
  );
}

module.exports = {
  createIngestionRun,
  ensureMaster,
  finishIngestionRun,
  insertQualityIssue,
  insertRawRecord,
  sourceIds,
  syncAnalytics,
  syncQualityIssues,
  syncReportRows,
  writeStatementWideRow,
  syncOfficialDividends,
  officialDividendSourceKey,
  legacyOfficialDividendSourceKeys,
  orderDividendBatchForUpsert,
  dividendBatchPeersOf,
  syncSourcedDividendFacts,
  upsertAdjustmentFactor,
  upsertCompanyEvent,
  upsertCorporateAction,
  upsertDailyBar,
  upsertDailyValuation,
  upsertDocument,
  upsertEarningsGuidance,
  upsertFinancialCursor,
  upsertShareCapital,
};
