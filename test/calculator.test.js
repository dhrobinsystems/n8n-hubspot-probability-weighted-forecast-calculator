'use strict';

/**
 * calculator.test.js
 *
 * Run with: npm test   (node --test, zero dependencies)
 *
 *   1. Config fail-safe defaults and gates
 *   2. Pipeline normalization and deal journeys
 *   3. Stage statistics: hand-computed rates, smoothing, intervals, monotonicity
 *   4. Forecast math, periods, and sheet rows
 *   5. Full fixture run (three pages, 120 deals, two pipelines)
 *   6. Runner: dry run, portal gate, pagination, Sheets upsert, JWT, retries
 *   7. workflow.json structure, gate topology, and Code-node parity
 *   8. Repository security scan
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const config = require('../src/config');
const calc = require('../src/calculator');
const runner = require('../src/index');
const builder = require('../scripts/build-workflow');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hubspot-deals-mock.json'), 'utf8'));
const NOW = new Date(FIXTURE._meta.reference_now);
const SANDBOX_SHEET = 'sandboxSheetId0000000000000000001';
const PROD_SHEET = 'productionSheetId00000000000000002';

function plain(v) { return JSON.parse(JSON.stringify(v)); }
function cfgFrom(env) { return config.parseConfig(env || {}); }
function fixturePages() { return FIXTURE.deal_pages.map(function (p) { return plain(p.response.body); }); }
function fixtureForecast(env) {
  return calc.calculateForecast({ config: cfgFrom(env), pipelinesBody: plain(FIXTURE.pipelines.body), dealPages: fixturePages(), now: NOW });
}
const DAY = 86400000;
function daysAgo(n) { return new Date(NOW.getTime() - n * DAY).toISOString(); }
function daysAhead(n) { return new Date(NOW.getTime() + n * DAY).toISOString(); }

// A tiny pipeline whose rates I can compute by hand.
const MINI_PIPELINES = {
  results: [{
    id: 'mini', label: 'Mini Pipeline', archived: false,
    stages: [
      { id: 'won', label: 'Won', displayOrder: 2, metadata: { isClosed: 'true', probability: '1.0' } },
      { id: 'a', label: 'Stage A', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.3' } },
      { id: 'b', label: 'Stage B', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.6' } },
      { id: 'lost', label: 'Lost', displayOrder: 3, metadata: { isClosed: 'true', probability: '0.0' } }
    ]
  }]
};

function miniDeal(id, path, options) {
  const opts = options || {};
  const closedDaysAgo = opts.closedDaysAgo === undefined ? 30 : opts.closedDaysAgo;
  const last = path[path.length - 1];
  const closed = last === 'won' || last === 'lost';
  const history = path.map(function (stage, i) { return { value: stage, timestamp: daysAgo(closedDaysAgo + (path.length - 1 - i) * 5) }; }).reverse();
  return {
    id: id,
    properties: {
      pipeline: opts.pipeline || 'mini',
      dealstage: last,
      amount: opts.amount === undefined ? '1000' : opts.amount,
      closedate: opts.closedate !== undefined ? opts.closedate : (closed ? daysAgo(closedDaysAgo) : null),
      hs_is_closed: closed ? 'true' : 'false'
    },
    propertiesWithHistory: { dealstage: history }
  };
}

function miniDeals() {
  return [
    miniDeal('1', ['a', 'b', 'won']),
    miniDeal('2', ['a', 'b', 'lost']),
    miniDeal('3', ['a', 'lost']),
    miniDeal('4', ['a', 'lost']),
    miniDeal('5', ['b', 'won']),
    miniDeal('6', ['a', 'b', 'won'], { closedDaysAgo: 400 }),
    miniDeal('7', ['a'], { amount: '1000', closedate: daysAhead(20) }),
    miniDeal('8', ['a', 'b'], { amount: '2000', closedate: daysAhead(50) })
  ];
}

function miniForecast(env, deals) {
  return calc.calculateForecast({ config: cfgFrom(env), pipelinesBody: plain(MINI_PIPELINES), dealPages: [{ results: deals || miniDeals() }], now: NOW });
}

function stageRow(result, stageId) {
  return result.pipelines[0].stats.stages.find(function (s) { return s.stageId === stageId; });
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

test('config: DRY_RUN and SANDBOX_MODE default to true', function () {
  const cfg = cfgFrom();
  assert.deepEqual([cfg.dryRun, cfg.sandboxMode, cfg.writeMode, cfg.writesEnabled, cfg.target.spreadsheetId], [true, true, 'dry_run', false, null]);
  assert.deepEqual([cfg.lookbackDays, cfg.priorStrength, cfg.minSampleSize, cfg.enforceMonotonic, cfg.forecastPeriod], [365, 10, 20, true, 'month']);
  assert.deepEqual(cfg.target.tabs, { summary: 'Forecast Summary', stages: 'Stage Probabilities', periods: 'Forecast by Period' });
});

test('config: only the literal string "false" disables a safety flag', function () {
  ['0', 'no', 'off', '', 'flase'].forEach(function (v) {
    assert.equal(cfgFrom({ DRY_RUN: v }).dryRun, true, 'DRY_RUN=' + v);
    assert.equal(cfgFrom({ SANDBOX_MODE: v }).sandboxMode, true, 'SANDBOX_MODE=' + v);
  });
  assert.equal(cfgFrom({ DRY_RUN: ' FALSE ', GOOGLE_SHEETS_SANDBOX_ID: SANDBOX_SHEET }).writeMode, 'sandbox');
});

test('config: production needs ALLOW_PRODUCTION_MODE and a separate spreadsheet', function () {
  assert.throws(function () { cfgFrom({ SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_MODE/);
  assert.throws(function () { cfgFrom({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', DRY_RUN: 'false' }); }, /GOOGLE_SHEETS_ID/);
  assert.throws(function () {
    cfgFrom({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', DRY_RUN: 'false', GOOGLE_SHEETS_ID: PROD_SHEET, GOOGLE_SHEETS_SANDBOX_ID: PROD_SHEET });
  }, /different spreadsheets/);
  const prod = cfgFrom({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', DRY_RUN: 'false', GOOGLE_SHEETS_ID: PROD_SHEET, GOOGLE_SHEETS_SANDBOX_ID: SANDBOX_SHEET });
  assert.deepEqual([prod.writeMode, prod.target.spreadsheetId], ['production', PROD_SHEET]);
});

test('config: sandbox writes always target the sandbox spreadsheet', function () {
  assert.throws(function () { cfgFrom({ DRY_RUN: 'false' }); }, /GOOGLE_SHEETS_SANDBOX_ID/);
  const cfg = cfgFrom({ DRY_RUN: 'false', GOOGLE_SHEETS_ID: PROD_SHEET, GOOGLE_SHEETS_SANDBOX_ID: SANDBOX_SHEET });
  assert.equal(cfg.target.spreadsheetId, SANDBOX_SHEET);
});

test('config: values are validated', function () {
  assert.throws(function () { cfgFrom({ LOOKBACK_DAYS: '7' }); }, /LOOKBACK_DAYS/);
  assert.throws(function () { cfgFrom({ PRIOR_STRENGTH: '-1' }); }, /PRIOR_STRENGTH/);
  assert.throws(function () { cfgFrom({ FORECAST_PERIOD: 'week' }); }, /FORECAST_PERIOD/);
  assert.throws(function () { cfgFrom({ REPORT_TIMEZONE: 'Mars/Base' }); }, /REPORT_TIMEZONE/);
  assert.throws(function () { cfgFrom({ PIPELINE_IDS: 'default, bad id' }); }, /PIPELINE_IDS/);
  assert.throws(function () { cfgFrom({ GOOGLE_SHEETS_ID: 'short' }); }, /GOOGLE_SHEETS_ID/);
  assert.throws(function () { cfgFrom({ SUMMARY_TAB: 'Bad/Tab' }); }, /SUMMARY_TAB/);
  assert.throws(function () { cfgFrom({ STAGE_TAB: 'Forecast Summary' }); }, /three different tabs/);
  assert.throws(function () { cfgFrom({ HUBSPOT_BASE_URL: 'http://api.example.com' }); }, /https/);
  assert.deepEqual(cfgFrom({ PIPELINE_IDS: 'default, 1001' }).pipelineIds, ['default', '1001']);
});

test('config: loadConfig needs a service account only when writing, and redacts secrets', function () {
  assert.throws(function () { config.loadConfig({ DRY_RUN: 'false', GOOGLE_SHEETS_SANDBOX_ID: SANDBOX_SHEET }); }, /GOOGLE_SERVICE_ACCOUNT_FILE/);
  assert.throws(function () { config.loadConfig({ DASHBOARD_WEBHOOK_URL: 'http://hooks.example.com/x' }); }, /https/);
  const cfg = config.loadConfig({ HUBSPOT_ACCESS_TOKEN: 'test-token' });
  assert.equal(config.describeConfig(cfg).hubspotAccessToken, '[redacted]');
  assert.ok(Object.isFrozen(cfg));
});

test('config: HubSpot read gate allows only sandbox or developer test portals in sandbox mode', function () {
  const cfg = cfgFrom();
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'STANDARD', portalId: 1001 }).allowed, false);
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'SANDBOX', portalId: 1001 }).allowed, true);
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'DEVELOPER_TEST', portalId: 1001 }).allowed, true);
  assert.equal(config.evaluateHubSpotTarget(cfgFrom({ HUBSPOT_SANDBOX_PORTAL_ID: '2002' }), { accountType: 'SANDBOX', portalId: 1001 }).reason, 'sandbox_portal_id_mismatch');
  assert.equal(config.evaluateHubSpotTarget(cfgFrom({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true' }), { accountType: 'STANDARD' }).allowed, true);
});

// ---------------------------------------------------------------------------
// 2. Pipelines and journeys
// ---------------------------------------------------------------------------

test('pipelines: stages are ordered and closed won / lost are detected from metadata', function () {
  const { pipelines, warnings } = calc.normalizePipelines(MINI_PIPELINES, cfgFrom());
  assert.deepEqual(pipelines[0].stages.map(function (s) { return [s.id, s.isClosed, s.isWon, s.isLost, s.staticProbability]; }), [
    ['a', false, false, false, 0.3], ['b', false, false, false, 0.6], ['won', true, true, false, 1], ['lost', true, false, true, 0]
  ]);
  assert.deepEqual(warnings, []);
  const filtered = calc.normalizePipelines(plain(FIXTURE.pipelines.body), cfgFrom({ PIPELINE_IDS: '1001,missing' }));
  assert.deepEqual(filtered.pipelines.map(function (p) { return p.id; }), ['1001']);
  assert.deepEqual(filtered.warnings, ['configured_pipeline_not_found:missing']);
});

test('pipelines: the deal property list includes a date-entered property for every stage', function () {
  const props = calc.buildDealPropertyList(calc.normalizePipelines(MINI_PIPELINES, cfgFrom()).pipelines);
  ['amount', 'amount_in_home_currency', 'dealstage', 'closedate', 'hs_date_entered_a', 'hs_date_entered_b', 'hs_date_entered_won', 'hs_date_entered_lost'].forEach(function (p) {
    assert.ok(props.includes(p), p);
  });
});

test('journeys: stage history is ordered oldest-first and stages from other pipelines are ignored', function () {
  const pipeline = calc.normalizePipelines(MINI_PIPELINES, cfgFrom()).pipelines[0];
  const deal = miniDeal('1', ['a', 'b', 'won']);
  deal.propertiesWithHistory.dealstage.push({ value: 'foreign-stage', timestamp: daysAgo(999) });
  const j = calc.extractJourney(deal, pipeline);
  assert.deepEqual(j.visited, ['a', 'b', 'won']);
  assert.deepEqual([j.isClosed, j.isWon, j.source], [true, true, 'history']);
});

test('journeys: date-entered properties are the fallback, then the current stage alone', function () {
  const pipeline = calc.normalizePipelines(MINI_PIPELINES, cfgFrom()).pipelines[0];
  const viaDates = calc.extractJourney({ id: '9', properties: { pipeline: 'mini', dealstage: 'lost', hs_date_entered_a: daysAgo(40), hs_date_entered_lost: daysAgo(10), closedate: daysAgo(10) } }, pipeline);
  assert.deepEqual([viaDates.visited, viaDates.source], [['a', 'lost'], 'date_entered']);
  const bare = calc.extractJourney({ id: '10', properties: { pipeline: 'mini', dealstage: 'b', amount: '500' } }, pipeline);
  assert.deepEqual([bare.visited, bare.source, bare.amount], [['b'], 'current_stage_only', 500]);
  const home = calc.extractJourney({ id: '11', properties: { pipeline: 'mini', dealstage: 'a', amount: '100', amount_in_home_currency: '120' } }, pipeline);
  assert.equal(home.amount, 120, 'home-currency amount is preferred');
});

// ---------------------------------------------------------------------------
// 3. Stage statistics
// ---------------------------------------------------------------------------

test('stats: raw historical rates match a hand calculation (k = 0)', function () {
  const r = miniForecast({ PRIOR_STRENGTH: '0', ENFORCE_MONOTONIC: 'false' });
  const stats = r.pipelines[0].stats;
  assert.equal(stats.cohortSize, 5, 'the 400-day-old deal and open deals are excluded');
  assert.equal(stats.cohortWins, 2);
  const a = stageRow(r, 'a');
  assert.deepEqual([a.sampleSize, a.wins, a.observedWinRate, a.smoothedProbability, a.nextStageConversion, a.advancementRate], [4, 1, 0.25, 0.25, 0.5, 0.5]);
  const b = stageRow(r, 'b');
  assert.deepEqual([b.sampleSize, b.wins], [3, 2]);
  assert.ok(Math.abs(b.observedWinRate - 2 / 3) < 1e-12);
  assert.equal(b.nextStageConversion, null, 'last open stage has no next stage');
  assert.equal(stageRow(r, 'won').probability, 1);
  assert.equal(stageRow(r, 'lost').probability, 0);
});

test('stats: Beta smoothing shrinks toward the static HubSpot probability', function () {
  const r = miniForecast({ PRIOR_STRENGTH: '4', ENFORCE_MONOTONIC: 'false' });
  assert.ok(Math.abs(stageRow(r, 'a').smoothedProbability - (1 + 4 * 0.3) / (4 + 4)) < 1e-12);
  assert.ok(Math.abs(stageRow(r, 'b').smoothedProbability - (2 + 4 * 0.6) / (3 + 4)) < 1e-12);
  const heavy = miniForecast({ PRIOR_STRENGTH: '1000', ENFORCE_MONOTONIC: 'false' });
  assert.ok(Math.abs(stageRow(heavy, 'a').probability - 0.3) < 0.005, 'a huge prior reproduces the static probability');
});

test('stats: Wilson 90% interval brackets the observed rate', function () {
  const ci = calc.wilsonInterval(1, 4, 1.6448536);
  assert.ok(ci.low > 0 && ci.low < 0.25 && ci.high > 0.25 && ci.high < 1);
  assert.ok(Math.abs(ci.low - 0.0579) < 0.0005 && Math.abs(ci.high - 0.6438) < 0.0005);
  assert.deepEqual(calc.wilsonInterval(0, 0, 1.64), { low: null, high: null });
});

test('stats: low-confidence flags follow MIN_SAMPLE_SIZE', function () {
  const r = miniForecast({ MIN_SAMPLE_SIZE: '4' });
  assert.deepEqual([stageRow(r, 'a').lowConfidence, stageRow(r, 'b').lowConfidence], [false, true]);
});

test('stats: pool-adjacent-violators produces a non-decreasing fit', function () {
  assert.deepEqual(calc.poolAdjacentViolators([0.5, 0.3, 0.7], [1, 1, 1]).map(function (v) { return calc.round(v, 6); }), [0.4, 0.4, 0.7]);
  assert.deepEqual(calc.poolAdjacentViolators([0.9, 0.1], [3, 1]).map(function (v) { return calc.round(v, 6); }), [0.7, 0.7]);
  assert.deepEqual(calc.poolAdjacentViolators([0.1, 0.2, 0.3], [1, 1, 1]), [0.1, 0.2, 0.3]);
});

test('stats: monotonicity is enforced across stage order when history inverts it', function () {
  const deals = [miniDeal('1', ['a', 'won']), miniDeal('2', ['a', 'won']), miniDeal('3', ['b', 'lost']), miniDeal('4', ['b', 'lost'])];
  const raw = miniForecast({ PRIOR_STRENGTH: '0', ENFORCE_MONOTONIC: 'false' }, deals);
  assert.deepEqual([stageRow(raw, 'a').probability, stageRow(raw, 'b').probability], [1, 0]);
  const fitted = miniForecast({ PRIOR_STRENGTH: '0' }, deals);
  assert.deepEqual([stageRow(fitted, 'a').probability, stageRow(fitted, 'b').probability], [0.5, 0.5]);
  assert.equal(stageRow(fitted, 'a').monotonicAdjusted, true);
});

test('stats: a stage with no history falls back to its static probability', function () {
  const r = miniForecast({}, [miniDeal('1', ['a', 'lost'])]);
  assert.equal(stageRow(r, 'b').sampleSize, 0);
  assert.equal(stageRow(r, 'b').observedWinRate, null);
  assert.ok(Math.abs(stageRow(r, 'b').smoothedProbability - 0.6) < 1e-12);
});

// ---------------------------------------------------------------------------
// 4. Forecast and rows
// ---------------------------------------------------------------------------

test('forecast: open amounts are weighted by dynamic and static probabilities', function () {
  const r = miniForecast({ PRIOR_STRENGTH: '0', ENFORCE_MONOTONIC: 'false' });
  const totals = r.pipelines[0].forecast.totals;
  assert.equal(totals.deals, 2);
  assert.equal(totals.amount, 3000);
  assert.ok(Math.abs(totals.dynamicWeighted - (1000 * 0.25 + 2000 * (2 / 3))) < 1e-9);
  assert.ok(Math.abs(totals.staticWeighted - (1000 * 0.3 + 2000 * 0.6)) < 1e-9);
  const summary = r.rows.summary[0];
  assert.equal(summary.dynamic_weighted_forecast, 1583.33);
  assert.equal(summary.static_weighted_forecast, 1500);
  assert.equal(summary.forecast_delta, 83.33);
});

test('forecast: periods bucket by close date with past-due, later, and unscheduled', function () {
  const deals = [
    miniDeal('1', ['a', 'won']),
    miniDeal('2', ['a'], { closedate: daysAgo(45) }),
    miniDeal('3', ['a'], { closedate: daysAhead(3) }),
    miniDeal('4', ['a'], { closedate: daysAhead(400) }),
    miniDeal('5', ['a'], { closedate: null }),
    miniDeal('6', ['b'], { amount: '' , closedate: daysAhead(40) })
  ];
  const r = miniForecast({ FORECAST_PERIODS_AHEAD: '3' }, deals);
  const f = r.pipelines[0].forecast;
  assert.deepEqual(f.periodOrder, ['past_due', '2026-11', '2026-12', '2027-01', 'later', 'unscheduled']);
  assert.deepEqual(f.periodOrder.map(function (k) { return f.byPeriod[k].deals; }), [1, 1, 1, 0, 1, 1]);
  assert.equal(f.overdueOpenDeals, 1);
  assert.equal(f.dealsMissingAmount, 1);
  assert.equal(f.byPeriod['2026-12'].amount, 0, 'a deal without an amount is counted but adds no value');
});

test('forecast: quarter keys and report time zones are respected', function () {
  assert.equal(calc.periodKey(Date.parse('2026-11-14T00:00:00Z'), 'quarter', 'UTC'), '2026-Q4');
  assert.deepEqual(calc.periodSequence(Date.parse('2026-11-14T00:00:00Z'), 'quarter', 3, 'UTC'), ['2026-Q4', '2027-Q1', '2027-Q2']);
  assert.deepEqual(calc.periodSequence(Date.parse('2026-11-14T00:00:00Z'), 'month', 3, 'UTC'), ['2026-11', '2026-12', '2027-01']);
  assert.equal(calc.periodKey(Date.parse('2026-12-31T20:00:00Z'), 'month', 'Asia/Dhaka'), '2027-01');
  assert.equal(calc.periodKey(Date.parse('2026-12-31T20:00:00Z'), 'month', 'UTC'), '2026-12');
});

test('rows: every row has exactly the documented columns and a stable row key', function () {
  const r = miniForecast();
  r.rows.summary.forEach(function (row) { assert.deepEqual(Object.keys(row).sort(), calc.SUMMARY_COLUMNS.slice().sort()); });
  r.rows.stages.forEach(function (row) { assert.deepEqual(Object.keys(row).sort(), calc.STAGE_COLUMNS.slice().sort()); });
  r.rows.periods.forEach(function (row) { assert.deepEqual(Object.keys(row).sort(), calc.PERIOD_COLUMNS.slice().sort()); });
  assert.equal(r.rows.summary[0].row_key, '2026-11-14|mini');
  assert.equal(r.rows.stages[0].row_key, '2026-11-14|mini|a');
  assert.equal(r.rows.summary.length, 1, 'no all-pipelines row for a single pipeline');
});

test('rows: CRM-controlled labels cannot inject spreadsheet formulas', function () {
  assert.equal(calc.sheetText('=HYPERLINK("x")'), ' =HYPERLINK("x")');
  assert.equal(calc.sheetText('+1'), ' +1');
  assert.equal(calc.sheetText('Stage A'), 'Stage A');
  const evil = plain(MINI_PIPELINES);
  evil.results[0].label = '=IMPORTDATA("x")';
  const r = calc.calculateForecast({ config: cfgFrom(), pipelinesBody: evil, dealPages: [{ results: miniDeals() }], now: NOW });
  assert.equal(r.rows.summary[0].pipeline_name, ' =IMPORTDATA("x")');
});

// ---------------------------------------------------------------------------
// 5. Fixture run
// ---------------------------------------------------------------------------

test('fixture: all pages are read, other pipelines are excluded, and totals reconcile', function () {
  const r = fixtureForecast();
  assert.equal(r.dealsFetched, 120);
  assert.equal(r.dealsOutsideSelectedPipelines, 1);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.rows.summary.map(function (s) { return s.pipeline_id; }), ['default', '1001', calc.ALL_PIPELINES_ID]);
  r.pipelines.forEach(function (p) {
    const stageSum = p.stats.stages.reduce(function (sum, s) { return sum + ((p.forecast.byStage[s.stageId] || {}).dynamicWeighted || 0); }, 0);
    const periodSum = p.forecast.periodOrder.reduce(function (sum, k) { return sum + p.forecast.byPeriod[k].dynamicWeighted; }, 0);
    assert.ok(Math.abs(stageSum - p.forecast.totals.dynamicWeighted) < 1e-6);
    assert.ok(Math.abs(periodSum - p.forecast.totals.dynamicWeighted) < 1e-6);
  });
  const all = r.rows.summary[2];
  assert.ok(Math.abs(all.dynamic_weighted_forecast - (r.rows.summary[0].dynamic_weighted_forecast + r.rows.summary[1].dynamic_weighted_forecast)) < 0.02);
});

test('fixture: dynamic probabilities are non-decreasing by stage and within [0, 1]', function () {
  fixtureForecast().pipelines.forEach(function (p) {
    const open = p.stats.stages.filter(function (s) { return s.type === 'open'; });
    open.forEach(function (s, i) {
      assert.ok(s.probability >= 0 && s.probability <= 1);
      if (i > 0) assert.ok(s.probability >= open[i - 1].probability - 1e-12, p.pipeline.id + ':' + s.stageId);
    });
  });
});

test('fixture: closed deals without history still count via date-entered properties', function () {
  const r = fixtureForecast();
  assert.equal(r.pipelines[0].stats.cohortSize, 84, 'six deals closed outside the 365-day lookback are excluded');
  assert.equal(r.pipelines[0].stats.historyCoverage, 1);
  const stripped = fixturePages().map(function (page) {
    page.results.forEach(function (d) { delete d.propertiesWithHistory; });
    return page;
  });
  const viaDates = calc.calculateForecast({ config: cfgFrom(), pipelinesBody: plain(FIXTURE.pipelines.body), dealPages: stripped, now: NOW });
  assert.deepEqual(viaDates.rows.stages, r.rows.stages, 'history and date-entered properties agree on the fixture');
});

test('fixture: open-deal edge cases are reported', function () {
  const s = fixtureForecast().rows.summary[0];
  assert.deepEqual([s.open_deals, s.deals_missing_amount, s.overdue_open_deals], [20, 1, 1]);
  const periods = fixtureForecast().rows.periods.filter(function (p) { return p.pipeline_id === 'default'; });
  assert.equal(periods.find(function (p) { return p.period === 'past_due'; }).open_deals, 1);
  assert.equal(periods.find(function (p) { return p.period === 'unscheduled'; }).open_deals, 1);
  assert.equal(periods.find(function (p) { return p.period === 'later'; }).open_deals, 1);
});

test('fixture: the calculation is deterministic and independent of page order', function () {
  const a = fixtureForecast();
  const reversed = calc.calculateForecast({ config: cfgFrom(), pipelinesBody: plain(FIXTURE.pipelines.body), dealPages: fixturePages().reverse(), now: NOW });
  assert.deepEqual(reversed.rows, a.rows);
});

// ---------------------------------------------------------------------------
// 6. Runner
// ---------------------------------------------------------------------------

function fixtureClient(overrides) {
  const base = runner.createFixtureHubSpotClient(Object.assign(plain(FIXTURE), overrides || {}));
  const calls = [];
  return { calls: calls, request: async function (m, p, b) { calls.push(m + ' ' + p.split('?')[0]); return base.request(m, p, b); } };
}

function recordingSheets() {
  const calls = [];
  return { calls: calls, upsertRows: async function (id, tab, columns, rows) { calls.push({ id: id, tab: tab, columns: columns, rows: rows }); return { tab: tab, updated: 0, appended: rows.length }; } };
}

test('runner: default dry run reads the sandbox portal and writes nothing', async function () {
  const sheets = recordingSheets();
  const client = fixtureClient();
  const result = await runner.runForecast({ config: config.loadConfig({}), hubspotClient: client, sheetsWriter: sheets, now: function () { return NOW; } });
  assert.equal(result.writes.status, 'dry_run');
  assert.equal(sheets.calls.length, 0);
  assert.deepEqual(client.calls, ['GET /account-info/v3/details', 'GET /crm/v3/pipelines/deals', 'GET /crm/v3/objects/deals', 'GET /crm/v3/objects/deals', 'GET /crm/v3/objects/deals']);
  assert.equal(result.portal.accountType, 'DEVELOPER_TEST');
});

test('runner: the portal gate stops before any deal data is read', async function () {
  const client = fixtureClient({ account: { statusCode: 200, body: { portalId: 1001, accountType: 'STANDARD' } } });
  await assert.rejects(runner.runForecast({ config: config.loadConfig({}), hubspotClient: client, now: function () { return NOW; } }), /HubSpot read blocked by gate/);
  assert.deepEqual(client.calls, ['GET /account-info/v3/details']);
});

test('runner: sandbox writes go to the sandbox spreadsheet tabs and the dashboard hook', async function () {
  const sheets = recordingSheets();
  const posted = [];
  const fetchImpl = async function (url, init) {
    posted.push({ url: url, body: JSON.parse(init.body) });
    return { status: 200, headers: { get: function () { return null; } }, text: async function () { return '{}'; } };
  };
  const cfg = config.loadConfig({ DRY_RUN: 'false', GOOGLE_SHEETS_ID: PROD_SHEET, GOOGLE_SHEETS_SANDBOX_ID: SANDBOX_SHEET, GOOGLE_SERVICE_ACCOUNT_FILE: '/dev/null', DASHBOARD_WEBHOOK_URL: 'https://dashboard.example.com/hook' });
  const result = await runner.runForecast({ config: cfg, hubspotClient: fixtureClient(), sheetsWriter: sheets, fetchImpl: fetchImpl, now: function () { return NOW; } });
  assert.deepEqual(sheets.calls.map(function (c) { return [c.id, c.tab]; }), [
    [SANDBOX_SHEET, 'Forecast Summary'], [SANDBOX_SHEET, 'Stage Probabilities'], [SANDBOX_SHEET, 'Forecast by Period']
  ]);
  assert.equal(sheets.calls[0].rows[0].write_mode, 'sandbox');
  assert.equal(result.writes.dashboard, 'sent');
  assert.equal(posted[0].url, 'https://dashboard.example.com/hook');
  assert.equal(posted[0].body.summary.length, 3);
});

test('runner: pagination follows cursors and reports truncation at MAX_DEAL_PAGES', async function () {
  const all = await runner.fetchDealPages(fixtureClient(), ['dealstage'], cfgFrom());
  assert.deepEqual([all.pages.length, all.truncated], [3, false]);
  const capped = await runner.fetchDealPages(fixtureClient(), ['dealstage'], cfgFrom({ MAX_DEAL_PAGES: '2' }));
  assert.deepEqual([capped.pages.length, capped.truncated], [2, true]);
  const r = calc.calculateForecast({ config: cfgFrom(), pipelinesBody: plain(FIXTURE.pipelines.body), dealPages: capped.pages, truncated: true, now: NOW });
  assert.ok(r.warnings.includes('deal_fetch_truncated_at_max_pages'));
});

test('runner: JSON client retries 429 with Retry-After', async function () {
  let calls = 0;
  const delays = [];
  const client = new runner.JsonClient({
    fetchImpl: async function () {
      calls++;
      return calls < 3
        ? { status: 429, headers: { get: function () { return '2'; } }, text: async function () { return '{}'; } }
        : { status: 200, headers: { get: function () { return null; } }, text: async function () { return '{"ok":true}'; } };
    },
    sleep: async function (ms) { delays.push(ms); }
  });
  const res = await client.request('GET', 'https://api.example.com/x');
  assert.deepEqual([res.statusCode, res.body.ok, delays], [200, true, [2000, 2000]]);
});

test('sheets: service-account JWT is RS256-signed and verifiable', function () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = runner.signServiceAccountJwt({ client_email: 'forecast-bot@project.example.com', private_key: pem }, 1790000000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  assert.deepEqual([claims.iss, claims.scope, claims.exp - claims.iat], ['forecast-bot@project.example.com', 'https://www.googleapis.com/auth/spreadsheets', 3600]);
  assert.equal(crypto.createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, Buffer.from(s, 'base64url')), true);
  assert.throws(function () { runner.signServiceAccountJwt({}, 1); }, /client_email and private_key/);
});

test('sheets: upsert updates existing row keys, appends new ones, extends headers, and writes RAW', async function () {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async function (url, init) {
    calls.push({ url: url, method: init.method, body: init.body });
    let body = {};
    if (url.indexOf('oauth2') !== -1) body = { access_token: 'ya-test', expires_in: 3600 };
    else if (init.method === 'GET') body = { values: [['row_key', 'run_date'], ['2026-11-14|default', '2026-11-14'], ['2026-11-13|default', '2026-11-13']] };
    return { status: 200, headers: { get: function () { return null; } }, text: async function () { return JSON.stringify(body); } };
  };
  const writer = new runner.SheetsWriter({ serviceAccount: { client_email: 'forecast-bot@project.example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl: fetchImpl });
  const out = await writer.upsertRows(SANDBOX_SHEET, 'Forecast Summary', ['row_key', 'run_date', 'open_amount'], [
    { row_key: '2026-11-14|default', run_date: '2026-11-14', open_amount: 100 },
    { row_key: '2026-11-14|1001', run_date: '2026-11-14', open_amount: 50 }
  ]);
  assert.deepEqual([out.updated, out.appended], [1, 1]);
  const header = calls.find(function (c) { return c.method === 'PUT'; });
  assert.deepEqual(JSON.parse(header.body).values, [['row_key', 'run_date', 'open_amount']]);
  assert.ok(header.url.includes('valueInputOption=RAW'));
  const update = JSON.parse(calls.find(function (c) { return /values:batchUpdate$/.test(c.url); }).body);
  assert.deepEqual([update.valueInputOption, update.data[0].range], ['RAW', "'Forecast Summary'!A2:C2"]);
  const append = calls.find(function (c) { return /:append\?/.test(c.url); });
  assert.ok(append.url.includes('valueInputOption=RAW'));
  assert.deepEqual(JSON.parse(append.body).values, [['2026-11-14|1001', '2026-11-14', 50]]);
  assert.equal(runner.columnLetter(0), 'A');
  assert.equal(runner.columnLetter(27), 'AB');
});

test('sheets: a missing tab is created before writing', async function () {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async function (url, init) {
    calls.push({ url: url, method: init.method, body: init.body });
    const status = init.method === 'GET' ? 400 : 200;
    const body = url.indexOf('oauth2') !== -1 ? { access_token: 'ya-test' } : {};
    return { status: status, headers: { get: function () { return null; } }, text: async function () { return JSON.stringify(body); } };
  };
  const writer = new runner.SheetsWriter({ serviceAccount: { client_email: 'forecast-bot@project.example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl: fetchImpl });
  await writer.upsertRows(SANDBOX_SHEET, 'Stage Probabilities', ['row_key'], [{ row_key: 'k1' }]);
  const add = calls.find(function (c) { return /:batchUpdate$/.test(c.url) && c.url.indexOf('values') === -1; });
  assert.deepEqual(JSON.parse(add.body), { requests: [{ addSheet: { properties: { title: 'Stage Probabilities' } } }] });
});

// ---------------------------------------------------------------------------
// 7. workflow.json
// ---------------------------------------------------------------------------

const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));

function nodeByName(name) {
  const node = WORKFLOW.nodes.find(function (n) { return n.name === name; });
  assert.ok(node, 'missing node ' + name);
  return node;
}

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); }
  static now() { return NOW.getTime(); }
}

function runCodeNode(name, context) {
  const sandbox = Object.assign({ console: console, Intl: Intl, Date: FixedDate }, context);
  vm.createContext(sandbox);
  return plain(vm.runInContext('(function () {\n' + nodeByName(name).parameters.jsCode + '\n})()', sandbox));
}

function itemsOf(list) {
  return { first: function () { return { json: list[0] }; }, all: function () { return list.map(function (j) { return { json: j }; }); } };
}

function refs(outputs) {
  return function (name) {
    if (!(name in outputs)) throw new Error('Unexpected node reference ' + name);
    return itemsOf([outputs[name]]);
  };
}

test('workflow: is valid, inactive, scheduled, and in sync with src/', function () {
  assert.equal(WORKFLOW.active, false);
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), builder.render(), 'run npm run build:workflow');
  const names = WORKFLOW.nodes.map(function (n) { return n.name; });
  assert.equal(new Set(names).size, names.length);
  Object.keys(WORKFLOW.connections).forEach(function (from) {
    assert.ok(names.includes(from), from);
    WORKFLOW.connections[from].main.forEach(function (branch) { branch.forEach(function (e) { assert.ok(names.includes(e.node), e.node); }); });
  });
  assert.equal(nodeByName('Daily Forecast Schedule').type, 'n8n-nodes-base.scheduleTrigger');
  ['Google Sheets: Upsert Forecast Summary', 'Google Sheets: Upsert Stage Probabilities', 'Google Sheets: Upsert Forecast by Period'].forEach(function (n) {
    const p = nodeByName(n).parameters;
    assert.deepEqual([p.operation, p.columns.matchingColumns, p.options.cellFormat], ['appendOrUpdate', ['row_key'], 'RAW']);
  });
});

test('workflow: contains no credential references or placeholder values', function () {
  WORKFLOW.nodes.forEach(function (n) { assert.equal(n.credentials, undefined, n.name); });
  const text = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  assert.equal(text.includes(['REPLACE', 'WITH'].join('_')), false);
});

test('workflow: config node defaults to DRY_RUN and SANDBOX_MODE, even with env access blocked', function () {
  const open = runCodeNode(builder.CONFIG_NODE, { $env: {} })[0].json.config;
  assert.deepEqual([open.writeMode, open.dataMode, open.writesEnabled, open.dashboardWebhookConfigured], ['dry_run', 'sandbox', false, false]);
  const blocked = new Proxy({}, { get: function () { throw new Error('access to env vars denied'); } });
  assert.equal(runCodeNode(builder.CONFIG_NODE, { $env: blocked })[0].json.config.writeMode, 'dry_run');
  assert.throws(function () { runCodeNode(builder.CONFIG_NODE, { $env: { SANDBOX_MODE: 'false' } }); }, /ALLOW_PRODUCTION_MODE/);
});

test('workflow: the portal gate node blocks a production portal in sandbox mode', function () {
  const outputs = { [builder.CONFIG_NODE]: { config: cfgFrom() } };
  assert.throws(function () {
    runCodeNode(builder.GATE_NODE, { $: refs(outputs), $input: itemsOf([{ portalId: 1001, accountType: 'STANDARD' }]) });
  }, /HubSpot read blocked by gate/);
  assert.throws(function () { runCodeNode(builder.GATE_NODE, { $: refs(outputs), $input: itemsOf([{ error: { message: 'x' } }]) }); }, /Unable to verify/);
  const ok = runCodeNode(builder.GATE_NODE, { $: refs(outputs), $input: itemsOf([FIXTURE.account.body]) })[0].json;
  assert.equal(ok.portal.verdict, 'sandbox_portal_verified');
});

test('workflow: plan and calculate nodes match src/calculator.js on the fixture', function () {
  const cfg = cfgFrom();
  const portal = { portalId: 1001, accountType: 'DEVELOPER_TEST', verdict: 'sandbox_portal_verified' };
  const plan = runCodeNode(builder.PLAN_NODE, { $: refs({ [builder.GATE_NODE]: { config: cfg, portal: portal } }), $input: itemsOf([plain(FIXTURE.pipelines.body)]) })[0].json;
  assert.equal(plan.properties, calc.buildDealPropertyList(calc.normalizePipelines(FIXTURE.pipelines.body, cfg).pipelines).join(','));
  const outputs = { [builder.PLAN_NODE]: plan, [builder.GATE_NODE]: { config: cfg, portal: portal }, [builder.PIPELINES_NODE]: plain(FIXTURE.pipelines.body) };
  const out = runCodeNode(builder.CALC_NODE, { $: refs(outputs), $input: itemsOf(fixturePages()) })[0].json;
  const expected = fixtureForecast();
  assert.deepEqual(out.rows, plain(expected.rows));
  assert.deepEqual([out.writesEnabled, out.target.spreadsheetId, out.dealsFetched], [false, null, 120]);
});

test('workflow: Sheets and dashboard nodes are reachable only through Writes Enabled?, CRM reads only after the gate', function () {
  const edges = [];
  Object.keys(WORKFLOW.connections).forEach(function (from) {
    WORKFLOW.connections[from].main.forEach(function (branch, out) { branch.forEach(function (e) { edges.push({ from: from, out: out, to: e.node }); }); });
  });
  function reachable(skip) {
    const starts = ['Daily Forecast Schedule', 'Manual Run (Testing)'];
    const seen = new Set(starts);
    const queue = starts.slice();
    while (queue.length) {
      const cur = queue.shift();
      edges.filter(function (e) { return e.from === cur && !skip(e); }).forEach(function (e) { if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); } });
    }
    return seen;
  }
  const writeNodes = WORKFLOW.nodes.filter(function (n) { return n.type === 'n8n-nodes-base.googleSheets' || n.name === 'Dashboard: Push Summary'; }).map(function (n) { return n.name; });
  assert.equal(writeNodes.length, 4);
  const all = reachable(function () { return false; });
  writeNodes.forEach(function (n) { assert.ok(all.has(n), n); });
  const noWriteGate = reachable(function (e) { return e.from === 'Writes Enabled?' && e.out === 0; });
  writeNodes.forEach(function (n) { assert.equal(noWriteGate.has(n), false, n + ' bypasses Writes Enabled?'); });
  const noPortalGate = reachable(function (e) { return e.from === builder.GATE_NODE; });
  [builder.PIPELINES_NODE, 'HubSpot: Deals with Stage History'].forEach(function (n) { assert.equal(noPortalGate.has(n), false, n + ' bypasses the portal gate'); });
});

// ---------------------------------------------------------------------------
// 8. Security scan
// ---------------------------------------------------------------------------

const DOMAIN_ALLOWLIST = {
  'dhrobinsystems.com': 'author website and contact (README author block)',
  'behance.net': 'author portfolio (README author block)',
  'linkedin.com': 'author profile (README author block)',
  'github.com': 'repository links in README and package.json',
  'hubapi.com': 'HubSpot API base URL',
  'googleapis.com': 'Google OAuth and Sheets API endpoints'
};
const ALLOWED_EMAIL_DOMAINS = ['dhrobinsystems.com'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage']);

function listRepoFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (entry) {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listRepoFiles(full) : [full];
  });
}

function isRfc2606(host) {
  return /(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)(test|example|invalid|localhost)$/.test(host);
}

function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return isRfc2606(h) || Object.keys(DOMAIN_ALLOWLIST).some(function (d) { return h === d || h.endsWith('.' + d); });
}

const SECRET_PATTERNS = [
  { name: 'private key block', re: new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' ')) },
  { name: 'HubSpot private app token', re: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'HubSpot legacy API key', re: /hapikey=[0-9a-f]{8}-[0-9a-f]{4}-/i },
  { name: 'Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google service account key', re: /"type"\s*:\s*"service_account"/ },
  { name: 'Real-looking spreadsheet ID in a URL', re: /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'hard-coded secret assignment', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK_URL)[ \t]*[=:][ \t]*["']?(?!https?:\/\/[a-z0-9.-]*example\.(?:com|org|net)\/)[A-Za-z0-9\-_./+:]{16,}/ }
];

test('security: no real secrets, keys, tokens, or spreadsheet IDs in any repository file', function () {
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    SECRET_PATTERNS.forEach(function (p) { if (p.re.test(text)) findings.push(path.relative(ROOT, file) + ': ' + p.name); });
  });
  assert.deepEqual(findings, []);
});

test('security: no placeholder credentials anywhere, no committed .env, and .env.example secrets are blank', function () {
  const marker = ['REPLACE', 'WITH'].join('_');
  listRepoFiles(ROOT).forEach(function (file) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(marker), false, path.relative(ROOT, file));
  });
  assert.equal(fs.existsSync(path.join(ROOT, '.env')), false);
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
  const secretKeys = ['HUBSPOT_ACCESS_TOKEN', 'GOOGLE_SHEETS_ID', 'GOOGLE_SHEETS_SANDBOX_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE', 'DASHBOARD_WEBHOOK_URL', 'HUBSPOT_SANDBOX_PORTAL_ID'];
  lines.forEach(function (line) {
    const key = line.slice(0, line.indexOf('='));
    const value = line.slice(line.indexOf('=') + 1).trim();
    if (secretKeys.includes(key)) assert.equal(value, '', key + ' must ship blank');
    else assert.match(value, /^(true|false|\d+|month|quarter|UTC|https:\/\/api\.hubapi\.com|Forecast Summary|Stage Probabilities|Forecast by Period|)$/, line);
  });
  ['DRY_RUN=true', 'SANDBOX_MODE=true', 'ALLOW_PRODUCTION_MODE=false'].forEach(function (l) { assert.ok(lines.includes(l), l); });
});

test('security: only RFC 2606 domains (plus the documented allowlist) appear in any file', function () {
  const domainRe = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev))\b/gi;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = domainRe.exec(text)) !== null) {
      const host = text.charAt(match.index - 1) === '%' ? match[1].slice(2) : match[1];
      if (!isAllowedHost(host)) findings.push(path.relative(ROOT, file) + ': ' + host);
    }
  });
  assert.deepEqual(Array.from(new Set(findings)), []);
});

test('security: every email address uses an RFC 2606 domain or the documented author contact', function () {
  const emailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = emailRe.exec(text)) !== null) {
      const domain = match[1].toLowerCase();
      if (!isRfc2606(domain) && !ALLOWED_EMAIL_DOMAINS.includes(domain)) findings.push(path.relative(ROOT, file) + ': ' + match[0]);
    }
  });
  assert.deepEqual(findings, []);
});

test('security: the scanner catches planted secrets and foreign domains', function () {
  const token = ['pat', 'na1', '12345678-1234-1234-1234-123456789abc'].join('-');
  const sa = '"type": "' + ['service', 'account'].join('_') + '"';
  [token, sa].forEach(function (s) { assert.ok(SECRET_PATTERNS.some(function (p) { return p.re.test(s); }), s.slice(0, 10)); });
  assert.equal(isAllowedHost(['acme-corp', 'com'].join('.')), false);
  assert.equal(isAllowedHost('dashboard.example.com'), true);
});
