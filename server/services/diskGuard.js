'use strict';

// 根盘余量停止线（INC-0054 第一阶段第 3 条）。
//
// 事故当天根盘 80% 已用、可用 11.8 GiB，而一次历史补采就能再写近 11 GiB 原始报文；
// 当时没有任何「空间不够就先把历史补采停下」的机制。本文件只做两件事：
// 读根盘余量、按统一阈值判定是否暂停历史补采——阈值集中在这里，
// 业务入口不各写一份数字，也不把「暂停」伪装成「补完了」。
const fs = require('fs');
const path = require('path');

const GIB = 1024 ** 3;
// 候选阈值（方案给出的首版演练值，落地后按正常基线与压测调整，可用环境变量覆盖）：
// 可用空间低于 max(8 GiB, 根盘总量的 15%, 下批预计空间峰值 + 业务余量) 时暂停历史补采。
const DEFAULT_MIN_FREE_BYTES = 8 * GIB;
const DEFAULT_TOTAL_RATIO = 0.15;
const DEFAULT_NEXT_BATCH_RESERVE_BYTES = 2 * GIB;

function numberFromEnv(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function thresholdsOf(env = process.env) {
  return {
    minFreeBytes: numberFromEnv(env.HISTORY_COLLECTION_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
    totalRatio: numberFromEnv(env.HISTORY_COLLECTION_TOTAL_RATIO, DEFAULT_TOTAL_RATIO),
    nextBatchReserveBytes: numberFromEnv(env.HISTORY_COLLECTION_NEXT_BATCH_RESERVE_BYTES, DEFAULT_NEXT_BATCH_RESERVE_BYTES),
  };
}

// 纯判定：给定余量与总量，算出停止线以及是否已低于停止线。
function historyCollectionSuspended({ freeBytes, totalBytes }, options = {}) {
  const limits = thresholdsOf(options.env);
  const minFree = Math.max(limits.minFreeBytes, Number(totalBytes || 0) * limits.totalRatio, limits.nextBatchReserveBytes);
  const free = Number(freeBytes || 0);
  return {
    suspended: free < minFree,
    freeBytes: free,
    totalBytes: Number(totalBytes || 0),
    minFreeBytes: minFree,
  };
}

// 读根盘（项目所在盘的根）实际余量；读不到返回 null，由调用方按「不暂停」处理，
// 不能因为读盘失败把补采永久挡住（失败要显式暴露，不静默改业务结论）。
async function readRootDisk(dir = process.cwd()) {
  try {
    const stats = await fs.promises.statfs(path.parse(path.resolve(dir)).root);
    const blockSize = Number(stats.bsize) || 4096;
    return {
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    };
  } catch (_) {
    return null;
  }
}

async function checkHistoryCollectionSpace(options = {}) {
  const disk = options.disk || await readRootDisk(options.dir);
  if (!disk) return { suspended: false, readable: false, reason: 'disk_usage_unavailable' };
  return { readable: true, ...historyCollectionSuspended(disk, options) };
}

module.exports = {
  GIB,
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_TOTAL_RATIO,
  DEFAULT_NEXT_BATCH_RESERVE_BYTES,
  thresholdsOf,
  historyCollectionSuspended,
  readRootDisk,
  checkHistoryCollectionSpace,
};
