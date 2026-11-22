'use strict';

/**
 * 市场周期「常见指数」10大目标指数统一目录配置。
 * 代码与 launchDate 均经理杏仁官方 cn/index 与 hk/index 目录接口实测核验（2026-11-22）。
 * storageCode 保持 CSI300 / 000985 / HSI 兼容存量 market.index_valuation_history。
 */
const MARKET_INDICES = Object.freeze([
  {
    order: 1,
    indexCode: '000001.SH',
    storageCode: '000001.SH',
    lixingerCode: '000001',
    name: '上证指数',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '1991-07-15',
  },
  {
    order: 2,
    indexCode: '000985.CSI',
    storageCode: '000985',
    lixingerCode: '000985',
    name: '中证全指',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '2011-08-02',
  },
  {
    order: 3,
    indexCode: '399001.SZ',
    storageCode: '399001.SZ',
    lixingerCode: '399001',
    name: '深证成指',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '1995-01-23',
  },
  {
    order: 4,
    indexCode: '000300.SH',
    storageCode: 'CSI300',
    lixingerCode: '000300',
    name: '沪深300',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '2005-04-08',
  },
  {
    order: 5,
    indexCode: '399006.SZ',
    storageCode: '399006.SZ',
    lixingerCode: '399006',
    name: '创业板指',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '2010-06-01',
  },
  {
    order: 6,
    indexCode: '000688.SH',
    storageCode: '000688.SH',
    lixingerCode: '000688',
    name: '科创50',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '2020-07-23',
  },
  {
    order: 7,
    indexCode: '899050.BJ',
    storageCode: '899050.BJ',
    lixingerCode: '899050',
    name: '北证50',
    market: 'CN',
    calendar: 'SSE',
    launchDate: '2022-11-21',
  },
  {
    order: 8,
    indexCode: 'HSI',
    storageCode: 'HSI',
    lixingerCode: 'HSI',
    name: '恒生指数',
    market: 'HK',
    calendar: 'HKEX',
    launchDate: '1989-03-09',
  },
  {
    order: 9,
    indexCode: 'HSCEI',
    storageCode: 'HSCEI',
    lixingerCode: 'HSCEI',
    name: '恒生中国指数',
    market: 'HK',
    calendar: 'HKEX',
    launchDate: '1994-08-08',
  },
  {
    order: 10,
    indexCode: 'HSTECH',
    storageCode: 'HSTECH',
    lixingerCode: 'HSTECH',
    name: '恒生科技指数',
    market: 'HK',
    calendar: 'HKEX',
    launchDate: '2020-07-01',
  },
]);

const BY_INDEX_CODE = new Map(MARKET_INDICES.map(item => [item.indexCode, item]));
const BY_STORAGE_CODE = new Map(MARKET_INDICES.map(item => [item.storageCode, item]));

function findMarketIndex(code) {
  const key = String(code || '').trim();
  return BY_INDEX_CODE.get(key) || BY_STORAGE_CODE.get(key) || null;
}

module.exports = {
  MARKET_INDICES,
  findMarketIndex,
};
