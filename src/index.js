#!/usr/bin/env node
'use strict';

/**
 * index.js
 *
 * Standalone runner. It mirrors workflow.json step for step:
 *
 *   config gates -> HubSpot account check (sandbox gate) -> deal pipelines
 *     -> deals with dealstage history (paginated) -> calculateForecast()
 *     -> [dry run: print preview]
 *     -> upsert Google Sheets tabs (sandbox or production spreadsheet)
 *     -> optional dashboard webhook
 *
 * Usage:
 *   node src/index.js                                  live HubSpot reads (dry run by default)
 *   node src/index.js --fixture test/fixtures/hubspot-deals-mock.json --now 2026-11-14T00:00:00Z
 *   node --env-file=.env src/index.js
 *
 * Zero runtime dependencies: global fetch (Node 18+), node:crypto, node:fs.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig, evaluateHubSpotTarget, describeConfig } = require('./config');
const { buildDealPropertyList, normalizePipelines, calculateForecast } = require('./calculator');

const DEAL_PAGE_SIZE = 50; // HubSpot's maximum when propertiesWithHistory is requested
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function createLogger(options) {
  const silent = Boolean(options && options.silent);
  const write = function (level, message, fields) {
    if (silent) return;
    process.stderr.write(JSON.stringify(Object.assign({ level: level, time: new Date().toISOString(), message: message }, fields || {})) + '\n');
  };
  return {
    info: function (m, f) { write('info', m, f); },
    warn: function (m, f) { write('warn', m, f); },
    error: function (m, f) { write('error', m, f); }
  };
}

/** JSON-over-HTTPS client with 429 / 5xx retries and timeouts. */
class JsonClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.headers = options.headers || {};
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.maxRetries = options.maxRetries === undefined ? 4 : options.maxRetries;
    this.baseDelayMs = options.baseDelayMs === undefined ? 500 : options.baseDelayMs;
    this.timeoutMs = options.timeoutMs || 30000;
    this.sleep = options.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    if (typeof this.fetch !== 'function') throw new Error('No fetch implementation available (Node 18+ required).');
  }

  async request(method, urlOrPath, body, extraHeaders) {
    const url = /^https?:\/\//.test(urlOrPath) ? urlOrPath : this.baseUrl + urlOrPath;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, this.timeoutMs);
      let response;
      try {
        const isForm = typeof body === 'string';
        response = await this.fetch(url, {
          method: method,
          headers: Object.assign({ Accept: 'application/json' },
            body === undefined || body === null ? {} : { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' },
            this.headers, extraHeaders || {}),
          body: body === undefined || body === null ? undefined : (isForm ? body : JSON.stringify(body)),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { await this.sleep(this.baseDelayMs * Math.pow(2, attempt)); continue; }
        return { statusCode: 0, body: { message: error.message } };
      }
      clearTimeout(timer);
      const text = await response.text();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch (error) { parsed = { raw: text.slice(0, 2000) }; } }
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return { statusCode: response.status, body: parsed };
    }
  }
}

function expectOk(result, context) {
  if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
  const detail = result.body && result.body.message ? ': ' + result.body.message
    : (result.body && result.body.error && result.body.error.message ? ': ' + result.body.error.message : '');
  const error = new Error(context + ' failed with status ' + result.statusCode + detail);
  error.statusCode = result.statusCode;
  throw error;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

function createHubSpotClient(cfg, fetchImpl) {
  if (!cfg.hubspotAccessToken) return null;
  return new JsonClient({ baseUrl: cfg.hubspotBaseUrl, headers: { Authorization: 'Bearer ' + cfg.hubspotAccessToken }, fetchImpl: fetchImpl });
}

/** Offline client answering from recorded responses ("METHOD /path" or deal pages by cursor). */
function createFixtureHubSpotClient(fixture) {
  return {
    request: async function (method, apiPath) {
      if (method === 'GET' && apiPath === '/account-info/v3/details') return JSON.parse(JSON.stringify(fixture.account));
      if (method === 'GET' && apiPath === '/crm/v3/pipelines/deals') return JSON.parse(JSON.stringify(fixture.pipelines));
      if (method === 'GET' && apiPath.indexOf('/crm/v3/objects/deals?') === 0) {
        const after = new URLSearchParams(apiPath.split('?')[1]).get('after') || '';
        const page = fixture.deal_pages.find(function (p) { return (p.after || '') === after; });
        return page ? JSON.parse(JSON.stringify(page.response)) : { statusCode: 404, body: { message: 'no page for cursor ' + after } };
      }
      return { statusCode: 404, body: { message: 'No fixture for ' + method + ' ' + apiPath } };
    }
  };
}

async function verifyPortal(client, cfg) {
  const account = expectOk(await client.request('GET', '/account-info/v3/details'), 'HubSpot account details');
  const verdict = evaluateHubSpotTarget(cfg, account);
  if (!verdict.allowed) throw new Error('HubSpot read blocked by gate: ' + verdict.reason);
  return { portalId: account.portalId, accountType: account.accountType, verdict: verdict.reason };
}

async function fetchDealPages(client, properties, cfg) {
  const pages = [];
  let after = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= cfg.maxDealPages) { truncated = true; break; }
    const query = new URLSearchParams({ limit: String(DEAL_PAGE_SIZE), archived: 'false', properties: properties.join(','), propertiesWithHistory: 'dealstage' });
    if (after) query.set('after', after);
    const body = expectOk(await client.request('GET', '/crm/v3/objects/deals?' + query.toString()), 'HubSpot deals page ' + (page + 1));
    pages.push(body);
    after = body && body.paging && body.paging.next && body.paging.next.after ? String(body.paging.next.after) : null;
    if (!after) break;
  }
  return { pages: pages, truncated: truncated };
}

// ---------------------------------------------------------------------------
// Google Sheets (service account, no SDK)
// ---------------------------------------------------------------------------

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signServiceAccountJwt(serviceAccount, nowSeconds) {
  if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('The Google service account file must contain client_email and private_key.');
  }
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({ iss: serviceAccount.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = crypto.createSign('RSA-SHA256').update(header + '.' + claims).sign(serviceAccount.private_key);
  return header + '.' + claims + '.' + base64Url(signature);
}

function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) { const r = (n - 1) % 26; letters = String.fromCharCode(65 + r) + letters; n = Math.floor((n - 1) / 26); }
  return letters;
}

class SheetsWriter {
  constructor(options) {
    this.serviceAccount = options.serviceAccount;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now || function () { return new Date(); };
    this.token = null;
  }

  async authorize() {
    if (this.token) return this.token;
    const assertion = signServiceAccountJwt(this.serviceAccount, Math.floor(this.now().getTime() / 1000));
    const client = new JsonClient({ fetchImpl: this.fetchImpl, maxRetries: 2 });
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion }).toString();
    const result = expectOk(await client.request('POST', TOKEN_URL, body), 'Google OAuth token exchange');
    this.token = result.access_token;
    return this.token;
  }

  async client() {
    const token = await this.authorize();
    return new JsonClient({ baseUrl: SHEETS_BASE, headers: { Authorization: 'Bearer ' + token }, fetchImpl: this.fetchImpl });
  }

  /**
   * Insert-or-update rows keyed by the `row_key` column. Creates the tab and
   * header row when missing, appends new columns to the header, and writes with
   * valueInputOption=RAW so no cell is ever evaluated as a formula.
   */
  async upsertRows(spreadsheetId, tab, columns, rows) {
    const api = await this.client();
    const base = '/' + encodeURIComponent(spreadsheetId);
    const quoted = "'" + tab.replace(/'/g, "''") + "'";
    let read = await api.request('GET', base + '/values/' + encodeURIComponent(quoted + '!A1:ZZ') + '?majorDimension=ROWS');
    if (read.statusCode === 400) {
      expectOk(await api.request('POST', base + ':batchUpdate', { requests: [{ addSheet: { properties: { title: tab } } }] }), 'Create tab ' + tab);
      read = { statusCode: 200, body: { values: [] } };
    }
    const values = expectOk(read, 'Read tab ' + tab).values || [];
    const header = (values[0] || []).map(String);
    let headerChanged = header.length === 0;
    columns.forEach(function (c) { if (header.indexOf(c) === -1) { header.push(c); headerChanged = true; } });
    if (headerChanged) {
      expectOk(await api.request('PUT', base + '/values/' + encodeURIComponent(quoted + '!A1') + '?valueInputOption=RAW', { values: [header] }), 'Write header ' + tab);
    }
    const keyIndex = header.indexOf('row_key');
    const existing = {};
    values.slice(1).forEach(function (row, i) { if (row[keyIndex]) existing[row[keyIndex]] = i + 2; });

    const updates = [];
    const appends = [];
    rows.forEach(function (row) {
      const line = header.map(function (h) { return row[h] === undefined || row[h] === null ? '' : row[h]; });
      const rowNumber = existing[row.row_key];
      if (rowNumber) updates.push({ range: quoted + '!A' + rowNumber + ':' + columnLetter(header.length - 1) + rowNumber, values: [line] });
      else appends.push(line);
    });
    if (updates.length) {
      expectOk(await api.request('POST', base + '/values:batchUpdate', { valueInputOption: 'RAW', data: updates }), 'Update rows ' + tab);
    }
    if (appends.length) {
      expectOk(await api.request('POST', base + '/values/' + encodeURIComponent(quoted + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: appends }), 'Append rows ' + tab);
    }
    return { tab: tab, updated: updates.length, appended: appends.length };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runForecast(deps) {
  const cfg = deps.config;
  const logger = deps.logger || createLogger({ silent: true });
  const now = deps.now ? deps.now() : new Date();
  const client = deps.hubspotClient || createHubSpotClient(cfg, deps.fetchImpl);
  if (!client) throw new Error('HUBSPOT_ACCESS_TOKEN is not set. Use a sandbox private app token, or --fixture for an offline dry run.');

  const portal = await verifyPortal(client, cfg);
  const pipelinesBody = expectOk(await client.request('GET', '/crm/v3/pipelines/deals'), 'HubSpot deal pipelines');
  const properties = buildDealPropertyList(normalizePipelines(pipelinesBody, cfg).pipelines);
  const fetched = await fetchDealPages(client, properties, cfg);
  const result = calculateForecast({ config: cfg, pipelinesBody: pipelinesBody, dealPages: fetched.pages, truncated: fetched.truncated, now: now });
  result.portal = portal;
  logger.info('forecast_calculated', { pipelines: result.pipelines.length, deals: result.dealsFetched, writeMode: cfg.writeMode, warnings: result.warnings });

  if (!cfg.writesEnabled) {
    result.writes = { status: 'dry_run', target: null };
    return result;
  }

  const writer = deps.sheetsWriter || new SheetsWriter({
    serviceAccount: JSON.parse(fs.readFileSync(path.resolve(cfg.googleServiceAccountFile), 'utf8')),
    fetchImpl: deps.fetchImpl,
    now: deps.now
  });
  const target = cfg.target;
  const writes = [];
  writes.push(await writer.upsertRows(target.spreadsheetId, target.tabs.summary, result.columns.summary, result.rows.summary));
  writes.push(await writer.upsertRows(target.spreadsheetId, target.tabs.stages, result.columns.stages, result.rows.stages));
  writes.push(await writer.upsertRows(target.spreadsheetId, target.tabs.periods, result.columns.periods, result.rows.periods));
  result.writes = { status: 'written', mode: cfg.writeMode, tabs: writes };

  if (cfg.dashboardWebhookUrl) {
    const hook = new JsonClient({ fetchImpl: deps.fetchImpl, maxRetries: 2 });
    const res = await hook.request('POST', cfg.dashboardWebhookUrl, { runAt: result.runAt, runDate: result.runDate, writeMode: cfg.writeMode, summary: result.rows.summary, warnings: result.warnings });
    result.writes.dashboard = res.statusCode >= 200 && res.statusCode < 300 ? 'sent' : 'failed_' + res.statusCode;
  }
  logger.info('forecast_written', { writes: result.writes });
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--now') args.now = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node src/index.js [--fixture <file.json>] [--now <ISO timestamp>]\n');
    return 0;
  }
  const cfg = loadConfig(process.env);
  const logger = createLogger();
  const now = args.now ? new Date(args.now) : null;
  if (now && !Number.isFinite(now.getTime())) throw new Error('--now must be an ISO timestamp.');
  const deps = { config: cfg, logger: logger, now: now ? function () { return now; } : undefined };
  if (args.fixture) {
    if (cfg.writesEnabled) throw new Error('--fixture is only allowed in dry run, so recorded data can never reach a real spreadsheet.');
    deps.hubspotClient = createFixtureHubSpotClient(JSON.parse(fs.readFileSync(path.resolve(args.fixture), 'utf8')));
  }
  logger.info('config_loaded', { config: describeConfig(cfg) });
  const result = await runForecast(deps);
  process.stdout.write(JSON.stringify({
    runDate: result.runDate,
    writeMode: result.writeMode,
    portal: result.portal,
    dealsFetched: result.dealsFetched,
    warnings: result.warnings,
    summary: result.rows.summary,
    stages: result.rows.stages,
    periods: result.rows.periods,
    writes: result.writes
  }, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }).catch(function (error) {
    process.stderr.write(JSON.stringify({ level: 'error', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  DEAL_PAGE_SIZE,
  JsonClient,
  createHubSpotClient,
  createFixtureHubSpotClient,
  verifyPortal,
  fetchDealPages,
  signServiceAccountJwt,
  columnLetter,
  SheetsWriter,
  runForecast,
  main
};
