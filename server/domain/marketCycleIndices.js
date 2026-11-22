'use strict';

const CoreDate = require('../../public/shared/core-date.js');

const PERIOD_KEYS = Object.freeze([
  '1d', '1w', '1m', '1q', 'ytd', 'ytd_mdd', '1y', '3y', '5y', '10y',
]);

function mergeIndexCloseAndValuationRows(closeRows = [], valuationRows = []) {
  const byDay = new Map();
  for (const row of closeRows || []) {
    const day = String(row.date || row.day || '').slice(0, 10);
    const close = Number(row.close);
    if (!day || !Number.isFinite(close) || close <= 0) continue;
    const prev = byDay.get(day) || { day, close: null, pe: null, pb: null, marketCap: null, raw: {} };
    prev.close = close;
    byDay.set(day, prev);
  }
  for (const row of valuationRows || []) {
    const day = String(row.day || row.date || '').slice(0, 10);
    if (!day) continue;
    const pe = Number.isFinite(Number(row.pe)) && Number(row.pe) > 0 ? Number(row.pe) : null;
    const pb = Number.isFinite(Number(row.pb)) && Number(row.pb) > 0 ? Number(row.pb) : null;
    const marketCap = Number.isFinite(Number(row.marketCap)) && Number(row.marketCap) > 0 ? Number(row.marketCap) : null;
    if (pe === null && pb === null && marketCap === null) continue;
    const prev = byDay.get(day) || { day, close: null, pe: null, pb: null, marketCap: null, raw: {} };
    if (pe !== null) prev.pe = pe;
    if (pb !== null) prev.pb = pb;
    if (marketCap !== null) prev.marketCap = marketCap;
    if (row.raw) prev.raw = row.raw;
    byDay.set(day, prev);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function calendarPeriodStart(dateStr, period) {
  const year = dateStr.slice(0, 4);
  const month = Number(dateStr.slice(5, 7));
  if (period === '1w') {
    const dt = new Date(`${dateStr}T00:00:00Z`);
    const dow = dt.getUTCDay();
    const offset = dow === 0 ? 6 : dow - 1;
    dt.setUTCDate(dt.getUTCDate() - offset);
    return dt.toISOString().slice(0, 10);
  }
  if (period === '1m') return `${dateStr.slice(0, 7)}-01`;
  if (period === '1q') {
    const qMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
    return `${year}-${qMonth}-01`;
  }
  if (period === 'ytd') return `${year}-01-01`;
  return null;
}

function downsampleSeries(points, maxPoints = 40) {
  if (!Array.isArray(points) || !points.length) return [];
  if (points.length <= maxPoints) return points.map(p => Number(p.close.toFixed(4)));
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = i === maxPoints - 1 ? points.length - 1 : Math.round(i * step);
    out.push(Number(points[idx].close.toFixed(4)));
  }
  return out;
}

function findLastIndexBefore(points, cutoffDate, inclusive = false) {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = points[mid].date;
    const ok = inclusive ? d <= cutoffDate : d < cutoffDate;
    if (ok) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function computePeriodMetric(closePoints, period) {
  if (!closePoints.length) {
    return { pct: null, baseDate: null, baseClose: null, sparkline: [] };
  }
  const latestIdx = closePoints.length - 1;
  const latest = closePoints[latestIdx];

  if (period === '1d') {
    if (latestIdx < 1) {
      return { pct: null, baseDate: null, baseClose: null, sparkline: downsampleSeries(closePoints, 40) };
    }
    const base = closePoints[latestIdx - 1];
    const pct = Number((((latest.close / base.close) - 1) * 100).toFixed(2));
    const slice = closePoints.slice(Math.max(0, closePoints.length - 20));
    return {
      pct,
      baseDate: base.date,
      baseClose: base.close,
      sparkline: downsampleSeries(slice, 40),
    };
  }

  if (period === 'ytd_mdd') {
    const yearStart = `${latest.date.slice(0, 4)}-01-01`;
    const startIdx = closePoints.findIndex(p => p.date >= yearStart);
    if (startIdx < 0) {
      return { pct: null, baseDate: null, baseClose: null, peakDate: null, troughDate: null, sparkline: [] };
    }
    const ytdSlice = closePoints.slice(startIdx);
    let peak = ytdSlice[0].close;
    let peakDate = ytdSlice[0].date;
    let maxMdd = 0;
    let bestPeakDate = ytdSlice[0].date;
    let bestTroughDate = ytdSlice[0].date;
    for (let i = 0; i < ytdSlice.length; i++) {
      const pt = ytdSlice[i];
      if (pt.close >= peak) {
        peak = pt.close;
        peakDate = pt.date;
      }
      const dd = ((pt.close - peak) / peak) * 100;
      if (dd <= maxMdd) {
        maxMdd = dd;
        bestPeakDate = peakDate;
        bestTroughDate = pt.date;
      }
    }
    return {
      pct: Number(maxMdd.toFixed(2)),
      baseDate: ytdSlice[0].date,
      baseClose: ytdSlice[0].close,
      peakDate: bestPeakDate,
      troughDate: bestTroughDate,
      sparkline: downsampleSeries(ytdSlice, 40),
    };
  }

  if (period === '1w' || period === '1m' || period === '1q' || period === 'ytd') {
    const startDate = calendarPeriodStart(latest.date, period);
    const baseIdx = findLastIndexBefore(closePoints, startDate, false);
    if (baseIdx < 0) {
      return { pct: null, baseDate: null, baseClose: null, sparkline: [] };
    }
    const base = closePoints[baseIdx];
    const pct = Number((((latest.close / base.close) - 1) * 100).toFixed(2));
    return {
      pct,
      baseDate: base.date,
      baseClose: base.close,
      sparkline: downsampleSeries(closePoints.slice(baseIdx), 40),
    };
  }

  const yearsMap = { '1y': 1, '3y': 3, '5y': 5, '10y': 10 };
  const years = yearsMap[period];
  if (!years) {
    return { pct: null, baseDate: null, baseClose: null, sparkline: [] };
  }
  const targetDate = CoreDate.subtractYears(latest.date, years);
  const baseIdx = findLastIndexBefore(closePoints, targetDate, true);
  if (baseIdx < 0) {
    return { pct: null, baseDate: null, baseClose: null, insufficientYears: years, sparkline: [] };
  }
  const base = closePoints[baseIdx];
  const pct = Number((((latest.close / base.close) - 1) * 100).toFixed(2));
  return {
    pct,
    baseDate: base.date,
    baseClose: base.close,
    sparkline: downsampleSeries(closePoints.slice(baseIdx), 40),
  };
}

function percentileFromSorted(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function computeSeriesPercentileStats(rows, field) {
  const valid = (rows || [])
    .map(r => ({ date: r.date, value: Number(r[field]) }))
    .filter(r => r.date && Number.isFinite(r.value) && r.value > 0);
  if (!valid.length) return null;
  const latestValue = valid[valid.length - 1].value;
  const sorted = valid.map(r => r.value).sort((a, b) => a - b);
  const less = sorted.filter(v => v < latestValue).length;
  const equal = sorted.filter(v => v === latestValue).length;
  return {
    count: sorted.length,
    current: Number(latestValue.toFixed(4)),
    p20: Number(percentileFromSorted(sorted, 0.2).toFixed(4)),
    p50: Number(percentileFromSorted(sorted, 0.5).toFixed(4)),
    p80: Number(percentileFromSorted(sorted, 0.8).toFixed(4)),
    percentile: Number((((less + equal * 0.5) / sorted.length) * 100).toFixed(2)),
  };
}

function buildIndexOverviewItem(meta, rows) {
  const sortedRows = (rows || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const closePoints = sortedRows
    .filter(r => Number.isFinite(Number(r.close)) && Number(r.close) > 0)
    .map(r => ({ date: r.date, close: Number(r.close) }));
  const latestClosePt = closePoints.at(-1) || null;
  const latestRow = sortedRows.at(-1) || null;
  const latestPeRow = [...sortedRows].reverse().find(r => Number.isFinite(Number(r.pe)) && Number(r.pe) > 0) || null;
  const latestPbRow = [...sortedRows].reverse().find(r => Number.isFinite(Number(r.pb)) && Number(r.pb) > 0) || null;

  const periods = {};
  for (const period of PERIOD_KEYS) {
    periods[period] = computePeriodMetric(closePoints, period);
  }

  const latestDate = latestClosePt ? latestClosePt.date : (latestRow ? latestRow.date : null);
  const cutoff10y = latestDate ? CoreDate.subtractYears(latestDate, 10) : null;
  const rows10y = cutoff10y ? sortedRows.filter(r => r.date >= cutoff10y) : sortedRows;

  return {
    order: meta.order,
    indexCode: meta.indexCode,
    storageCode: meta.storageCode,
    name: meta.name,
    market: meta.market,
    launchDate: meta.launchDate,
    latestDate,
    latestClose: latestClosePt ? Number(latestClosePt.close.toFixed(2)) : null,
    latestPe: latestPeRow ? Number(Number(latestPeRow.pe).toFixed(2)) : null,
    latestPb: latestPbRow ? Number(Number(latestPbRow.pb).toFixed(2)) : null,
    peStatsAll: computeSeriesPercentileStats(sortedRows, 'pe'),
    peStats10y: computeSeriesPercentileStats(rows10y, 'pe'),
    pbStatsAll: computeSeriesPercentileStats(sortedRows, 'pb'),
    pbStats10y: computeSeriesPercentileStats(rows10y, 'pb'),
    periods,
  };
}

module.exports = {
  PERIOD_KEYS,
  mergeIndexCloseAndValuationRows,
  calendarPeriodStart,
  downsampleSeries,
  computePeriodMetric,
  computeSeriesPercentileStats,
  buildIndexOverviewItem,
};
