'use strict';

/**
 * config.js
 *
 * Environment loader and safety gates for the forecast calculator.
 *
 * Two independent safety flags, both ON by default:
 *
 *   DRY_RUN=true       The forecast is calculated and returned as a preview.
 *                      Nothing is written to Google Sheets or a dashboard.
 *   SANDBOX_MODE=true  HubSpot is read only after the portal is verified as a
 *                      SANDBOX or DEVELOPER_TEST account, and every write goes to
 *                      the sandbox spreadsheet (GOOGLE_SHEETS_SANDBOX_ID), never
 *                      the production one.
 *
 * SANDBOX_MODE=false (production deal data, production spreadsheet) also needs
 * ALLOW_PRODUCTION_MODE=true. Only the literal string "false" turns a safety
 * flag off; typos, "0", "no", and empty values keep it on.
 *
 * The n8n-core:config region is embedded verbatim into the n8n Code nodes by
 * scripts/build-workflow.js, so it stays dependency-free.
 */

// <n8n-core:config>
const CONFIG_KEYS = [
  'DRY_RUN',
  'SANDBOX_MODE',
  'ALLOW_PRODUCTION_MODE',
  'HUBSPOT_BASE_URL',
  'HUBSPOT_SANDBOX_PORTAL_ID',
  'PIPELINE_IDS',
  'LOOKBACK_DAYS',
  'PRIOR_STRENGTH',
  'MIN_SAMPLE_SIZE',
  'ENFORCE_MONOTONIC',
  'FORECAST_PERIOD',
  'FORECAST_PERIODS_AHEAD',
  'REPORT_TIMEZONE',
  'MAX_DEAL_PAGES',
  'GOOGLE_SHEETS_ID',
  'GOOGLE_SHEETS_SANDBOX_ID',
  'SUMMARY_TAB',
  'STAGE_TAB',
  'PERIOD_TAB'
];

const SANDBOX_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];

function cfgBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function safetyFlag(value) {
  if (value === undefined || value === null) return true;
  return String(value).trim().toLowerCase() !== 'false';
}

function optInFlag(value) {
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInt(value, fallback, min, max, name) {
  if (cfgBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function boundedNumber(value, fallback, min, max, name) {
  if (cfgBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be a number between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function idList(value, name) {
  if (cfgBlank(value)) return [];
  return String(value).split(',').map(function (v) { return v.trim(); }).filter(Boolean).map(function (v) {
    if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error(name + ' may only contain letters, digits, "-" and "_".');
    return v;
  });
}

function sheetId(value, name) {
  if (cfgBlank(value)) return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error(name + ' must be a Google Sheets spreadsheet ID (the long ID in the sheet URL).');
  return id;
}

function tabName(value, fallback, name) {
  const tab = cfgBlank(value) ? fallback : String(value).trim();
  if (tab.length > 100 || /[\[\]*?:\\/']/.test(tab)) throw new Error(name + ' contains characters Google Sheets does not allow in tab names.');
  return tab;
}

function parseConfig(env) {
  const e = env || {};
  const dryRun = safetyFlag(e.DRY_RUN);
  const sandboxMode = safetyFlag(e.SANDBOX_MODE);
  const allowProductionMode = optInFlag(e.ALLOW_PRODUCTION_MODE);

  if (!sandboxMode && !allowProductionMode) {
    throw new Error(
      'Refusing to start: SANDBOX_MODE=false reads production deals and writes the production spreadsheet. ' +
      'Set ALLOW_PRODUCTION_MODE=true only after validating the forecast against a HubSpot sandbox.'
    );
  }

  const baseUrl = (cfgBlank(e.HUBSPOT_BASE_URL) ? 'https://api.hubapi.com' : String(e.HUBSPOT_BASE_URL).trim()).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('HUBSPOT_BASE_URL must use https://.');

  const portal = cfgBlank(e.HUBSPOT_SANDBOX_PORTAL_ID) ? null : String(e.HUBSPOT_SANDBOX_PORTAL_ID).trim();
  if (portal && !/^\d+$/.test(portal)) throw new Error('HUBSPOT_SANDBOX_PORTAL_ID must be numeric.');

  const period = cfgBlank(e.FORECAST_PERIOD) ? 'month' : String(e.FORECAST_PERIOD).trim().toLowerCase();
  if (period !== 'month' && period !== 'quarter') throw new Error('FORECAST_PERIOD must be "month" or "quarter".');

  const timezone = cfgBlank(e.REPORT_TIMEZONE) ? 'UTC' : String(e.REPORT_TIMEZONE).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch (error) {
    throw new Error('REPORT_TIMEZONE must be a valid IANA time zone (received "' + timezone + '").');
  }

  const productionSheet = sheetId(e.GOOGLE_SHEETS_ID, 'GOOGLE_SHEETS_ID');
  const sandboxSheet = sheetId(e.GOOGLE_SHEETS_SANDBOX_ID, 'GOOGLE_SHEETS_SANDBOX_ID');
  const writeMode = dryRun ? 'dry_run' : (sandboxMode ? 'sandbox' : 'production');
  const targetSheet = writeMode === 'sandbox' ? sandboxSheet : (writeMode === 'production' ? productionSheet : null);
  if (writeMode === 'sandbox' && !sandboxSheet) throw new Error('DRY_RUN=false with SANDBOX_MODE=true requires GOOGLE_SHEETS_SANDBOX_ID (a test spreadsheet).');
  if (writeMode === 'production' && !productionSheet) throw new Error('Production writes require GOOGLE_SHEETS_ID.');
  if (writeMode === 'production' && productionSheet === sandboxSheet) throw new Error('GOOGLE_SHEETS_ID and GOOGLE_SHEETS_SANDBOX_ID must be different spreadsheets.');

  const tabs = {
    summary: tabName(e.SUMMARY_TAB, 'Forecast Summary', 'SUMMARY_TAB'),
    stages: tabName(e.STAGE_TAB, 'Stage Probabilities', 'STAGE_TAB'),
    periods: tabName(e.PERIOD_TAB, 'Forecast by Period', 'PERIOD_TAB')
  };
  if (tabs.summary === tabs.stages || tabs.summary === tabs.periods || tabs.stages === tabs.periods) {
    throw new Error('SUMMARY_TAB, STAGE_TAB, and PERIOD_TAB must be three different tabs.');
  }

  return {
    dryRun: dryRun,
    sandboxMode: sandboxMode,
    allowProductionMode: allowProductionMode,
    writeMode: writeMode,
    dataMode: sandboxMode ? 'sandbox' : 'production',
    writesEnabled: writeMode !== 'dry_run',
    hubspotBaseUrl: baseUrl,
    sandboxPortalId: portal,
    pipelineIds: idList(e.PIPELINE_IDS, 'PIPELINE_IDS'),
    lookbackDays: boundedInt(e.LOOKBACK_DAYS, 365, 30, 1825, 'LOOKBACK_DAYS'),
    priorStrength: boundedNumber(e.PRIOR_STRENGTH, 10, 0, 1000, 'PRIOR_STRENGTH'),
    minSampleSize: boundedInt(e.MIN_SAMPLE_SIZE, 20, 1, 10000, 'MIN_SAMPLE_SIZE'),
    enforceMonotonic: safetyFlag(e.ENFORCE_MONOTONIC),
    forecastPeriod: period,
    forecastPeriodsAhead: boundedInt(e.FORECAST_PERIODS_AHEAD, 6, 1, 24, 'FORECAST_PERIODS_AHEAD'),
    reportTimezone: timezone,
    maxDealPages: boundedInt(e.MAX_DEAL_PAGES, 200, 1, 2000, 'MAX_DEAL_PAGES'),
    target: { spreadsheetId: targetSheet, tabs: tabs }
  };
}

function evaluateHubSpotTarget(cfg, account) {
  if (!cfg) return { allowed: false, reason: 'missing_config' };
  if (!cfg.sandboxMode) {
    return cfg.allowProductionMode
      ? { allowed: true, reason: 'production_mode_explicitly_allowed' }
      : { allowed: false, reason: 'production_mode_not_allowed' };
  }
  const type = String((account && account.accountType) || '').toUpperCase();
  if (SANDBOX_ACCOUNT_TYPES.indexOf(type) === -1) {
    return { allowed: false, reason: 'sandbox_mode_requires_sandbox_or_developer_test_portal (received "' + (type || 'unknown') + '")' };
  }
  if (cfg.sandboxPortalId && String(account.portalId) !== cfg.sandboxPortalId) {
    return { allowed: false, reason: 'sandbox_portal_id_mismatch' };
  }
  return { allowed: true, reason: 'sandbox_portal_verified' };
}
// </n8n-core:config>

/**
 * Full runtime config for the standalone engine. Secrets are read here only;
 * in n8n they live in the credential store and never pass through Code nodes.
 */
function loadConfig(env) {
  const source = env || process.env;
  const settings = parseConfig(source);
  const secret = function (name) { return cfgBlank(source[name]) ? null : String(source[name]).trim(); };
  const cfg = Object.assign({}, settings, {
    hubspotAccessToken: secret('HUBSPOT_ACCESS_TOKEN'),
    googleServiceAccountFile: secret('GOOGLE_SERVICE_ACCOUNT_FILE'),
    dashboardWebhookUrl: secret('DASHBOARD_WEBHOOK_URL')
  });
  if (cfg.dashboardWebhookUrl && !/^https:\/\//i.test(cfg.dashboardWebhookUrl)) {
    throw new Error('DASHBOARD_WEBHOOK_URL must use https://.');
  }
  if (cfg.writesEnabled && !cfg.googleServiceAccountFile) {
    throw new Error('Sheet writes are enabled but GOOGLE_SERVICE_ACCOUNT_FILE is not set.');
  }
  return Object.freeze(cfg);
}

function describeConfig(cfg) {
  const view = Object.assign({}, cfg);
  ['hubspotAccessToken', 'dashboardWebhookUrl'].forEach(function (key) {
    if (key in view) view[key] = view[key] ? '[redacted]' : null;
  });
  return view;
}

module.exports = {
  CONFIG_KEYS,
  SANDBOX_ACCOUNT_TYPES,
  safetyFlag,
  optInFlag,
  parseConfig,
  evaluateHubSpotTarget,
  loadConfig,
  describeConfig
};
