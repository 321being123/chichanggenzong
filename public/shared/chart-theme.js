// 图表主题读取器：统一从 CSS Design Tokens 读取图表色板、涨跌色、网格线、坐标轴与字体
(function () {
  'use strict';

  var DEFAULTS = {
    chart1: '#2563eb',
    chart2: '#0891b2',
    chart3: '#f59e0b',
    chart4: '#7c3aed',
    chart5: '#dc2626',
    chart6: '#059669',
    up: '#dc2626',
    down: '#059669',
    ok: '#059669',
    warn: '#d97706',
    grid: '#e2e8f0',
    axis: '#64748b',
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#64748b',
    textFaint: '#94a3b8',
    primary: '#2563eb',
    primaryLight: '#3b82f6',
    border: '#e2e8f0',
    bgSurface: '#ffffff',
    fontSans: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  };

  function readVar(name, fallback) {
    if (typeof document === 'undefined' || !document.documentElement || typeof getComputedStyle !== 'function') {
      return fallback;
    }
    var val = getComputedStyle(document.documentElement).getPropertyValue(name);
    return val && val.trim() ? val.trim() : fallback;
  }

  function getTheme() {
    return {
      chart1: readVar('--chart-1', DEFAULTS.chart1),
      chart2: readVar('--chart-2', DEFAULTS.chart2),
      chart3: readVar('--chart-3', DEFAULTS.chart3),
      chart4: readVar('--chart-4', DEFAULTS.chart4),
      chart5: readVar('--chart-5', DEFAULTS.chart5),
      chart6: readVar('--chart-6', DEFAULTS.chart6),
      up: readVar('--up', DEFAULTS.up),
      down: readVar('--down', DEFAULTS.down),
      ok: readVar('--ok', DEFAULTS.ok),
      warn: readVar('--warn', DEFAULTS.warn),
      grid: readVar('--chart-grid', DEFAULTS.grid),
      axis: readVar('--chart-axis', DEFAULTS.axis),
      textPrimary: readVar('--text-primary', DEFAULTS.textPrimary),
      textSecondary: readVar('--text-secondary', DEFAULTS.textSecondary),
      textMuted: readVar('--text-muted', DEFAULTS.textMuted),
      textFaint: readVar('--text-faint', DEFAULTS.textFaint),
      primary: readVar('--primary', DEFAULTS.primary),
      primaryLight: readVar('--primary-light', DEFAULTS.primaryLight),
      border: readVar('--border', DEFAULTS.border),
      bgSurface: readVar('--bg-surface', DEFAULTS.bgSurface),
      fontSans: readVar('--font-sans', DEFAULTS.fontSans)
    };
  }

  window.SiteChartTheme = {
    get: getTheme,
    token: readVar,
    defaults: DEFAULTS
  };
})();
