'use strict';

const { MARKET_INDICES, findMarketIndex } = require('../domain/marketIndexCatalog');
const { buildIndexOverviewItem } = require('../domain/marketCycleIndices');
const marketStrategyRepository = require('../repositories/marketStrategyRepository');

const STORAGE_CODES = MARKET_INDICES.map(item => item.storageCode);

async function getWatermarkVersion() {
  const wm = await marketStrategyRepository.readIndicesWatermark(STORAGE_CODES);
  if (!wm) return 'empty';
  return `${wm.latest_date || 'none'}|${wm.latest_ingested || 'none'}`;
}

async function getIndicesOverview() {
  const rows = await marketStrategyRepository.readAllIndicesHistory(STORAGE_CODES);
  const byStorage = new Map();
  for (const row of rows) {
    if (!byStorage.has(row.index_code)) byStorage.set(row.index_code, []);
    byStorage.get(row.index_code).push({
      date: row.date,
      close: row.close,
      pe: row.pe,
      pb: row.pb,
    });
  }
  const indices = MARKET_INDICES.map(meta => buildIndexOverviewItem(meta, byStorage.get(meta.storageCode) || []));
  const latestDates = indices.map(i => i.latestDate).filter(Boolean).sort();
  return {
    asOfDate: latestDates.at(-1) || null,
    indices,
  };
}

async function getIndexHistory(code) {
  const meta = findMarketIndex(code);
  if (!meta) return null;
  const rows = await marketStrategyRepository.readIndexFullHistory(meta.storageCode);
  return {
    index: {
      indexCode: meta.indexCode,
      storageCode: meta.storageCode,
      name: meta.name,
      market: meta.market,
      launchDate: meta.launchDate,
    },
    history: rows.map(r => ({
      date: r.date,
      close: r.close == null ? null : Number(r.close),
      pe: r.pe == null ? null : Number(r.pe),
      pb: r.pb == null ? null : Number(r.pb),
    })),
  };
}

module.exports = {
  getWatermarkVersion,
  getIndicesOverview,
  getIndexHistory,
};
