'use strict';

function formatDuration(ms) {
  return Number.isFinite(ms) && ms >= 0 ? (ms / 1000).toFixed(2) + 's' : '未知';
}

function summarizeTimings(entries, elapsedMs, limit = 10) {
  const measured = entries.filter(item => Number.isFinite(item.durationMs) && item.durationMs >= 0);
  const files = measured.filter(item => item.kind === 'file');
  const setupMs = measured.filter(item => item.kind === 'setup').reduce((sum, item) => sum + item.durationMs, 0);
  return {
    elapsedMs,
    fileMs: files.reduce((sum, item) => sum + item.durationMs, 0),
    setupMs,
    measuredFiles: files.length,
    slowest: files.slice().sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file)).slice(0, limit),
  };
}

module.exports = { formatDuration, summarizeTimings };
