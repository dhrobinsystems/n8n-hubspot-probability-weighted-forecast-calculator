'use strict';

/**
 * calculator.js
 *
 * Core probability-weighted forecast math. It runs identically in Node.js and
 * inside the n8n "Calculate Forecast" Code node (scripts/build-workflow.js
 * embeds the n8n-core:calculator region verbatim).
 *
 * Method, per pipeline:
 *
 *   1. Journeys. For every deal I rebuild the ordered list of stages it
 *      actually entered, from `propertiesWithHistory.dealstage`, falling back
 *      to the `hs_date_entered_<stageId>` properties, plus its current stage.
 *
 *   2. Cohort. Closed deals (won or lost) whose close date falls inside
 *      LOOKBACK_DAYS. Open deals are excluded from the rates on purpose: their
 *      outcome is unknown, and counting them would bias rates downward.
 *
 *   3. Stage statistics. For each open stage s:
 *        reached(s)       closed-cohort deals that entered s
 *        wins(s)          of those, deals that closed won
 *        observed(s)      wins / reached                 P(win | reached s)
 *        nextStage(s)     share of reached(s) that entered the next stage
 *        advancement(s)   share of reached(s) that entered any later stage or won
 *
 *   4. Smoothing. Small samples are shrunk toward the stage's static HubSpot
 *      probability with a Beta prior of strength k (PRIOR_STRENGTH):
 *        smoothed(s) = (wins + k * static) / (reached + k)
 *      k = 0 uses raw history; a larger k trusts the configured defaults more.
 *
 *   5. Monotonicity (ENFORCE_MONOTONIC). Win probability should not fall as a
 *      deal advances, so I fit a non-decreasing curve over stage order with
 *      weighted pool-adjacent-violators (weights = reached + k).
 *
 *   6. Forecast. Each open deal contributes amount x dynamic(stage). I report it
 *      next to the static forecast (amount x HubSpot stage probability), by
 *      stage and by close-date period.
 *
 * A Wilson 90% interval on the observed rate and a low-confidence flag
 * (reached < MIN_SAMPLE_SIZE) show how far each probability can be trusted.
 */

// <n8n-core:calculator>
const DAY_IN_MS = 86400000;
const WILSON_Z_90 = 1.6448536;
const BASE_DEAL_PROPERTIES = [
  'dealname', 'amount', 'amount_in_home_currency', 'deal_currency_code', 'dealstage', 'pipeline',
  'closedate', 'createdate', 'hs_is_closed', 'hs_is_closed_won', 'hs_lastmodifieddate'
];
const SUMMARY_COLUMNS = [
  'row_key', 'run_date', 'run_at', 'write_mode', 'pipeline_id', 'pipeline_name', 'open_deals', 'open_amount',
  'static_weighted_forecast', 'dynamic_weighted_forecast', 'forecast_delta', 'forecast_delta_pct',
  'cohort_closed_deals', 'cohort_win_rate', 'lookback_days', 'prior_strength', 'low_confidence_stages',
  'deals_missing_amount', 'overdue_open_deals', 'history_coverage_pct'
];
const STAGE_COLUMNS = [
  'row_key', 'run_date', 'pipeline_id', 'pipeline_name', 'stage_order', 'stage_id', 'stage_name',
  'static_probability', 'observed_win_rate', 'smoothed_probability', 'dynamic_probability', 'ci90_low', 'ci90_high',
  'sample_size', 'wins', 'next_stage_conversion', 'advancement_rate', 'low_confidence', 'monotonic_adjusted',
  'open_deals', 'open_amount', 'static_weighted', 'dynamic_weighted'
];
const PERIOD_COLUMNS = [
  'row_key', 'run_date', 'pipeline_id', 'pipeline_name', 'period', 'open_deals', 'open_amount', 'static_weighted', 'dynamic_weighted'
];
const ALL_PIPELINES_ID = '__all__';

function calcBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function toMs(value) {
  if (calcBlank(value)) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function toNumber(value) {
  if (calcBlank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sheetText(value) {
  // Neutralize spreadsheet formula injection from CRM-controlled labels.
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? ' ' + text : text;
}

function normalizePipelines(body, cfg) {
  const warnings = [];
  const wanted = (cfg && cfg.pipelineIds) || [];
  const raw = body && Array.isArray(body.results) ? body.results : [];
  const pipelines = raw
    .filter(function (p) { return p && !p.archived && (wanted.length === 0 || wanted.indexOf(String(p.id)) !== -1); })
    .map(function (p) {
      const stages = (Array.isArray(p.stages) ? p.stages : [])
        .filter(function (s) { return s && !s.archived; })
        .map(function (s) {
          const meta = s.metadata || {};
          const probability = toNumber(meta.probability);
          const isClosed = String(meta.isClosed) === 'true';
          const staticProbability = probability === null ? null : Math.min(1, Math.max(0, probability));
          return {
            id: String(s.id),
            label: String(s.label || s.id),
            order: Number.isFinite(Number(s.displayOrder)) ? Number(s.displayOrder) : 0,
            staticProbability: staticProbability,
            isClosed: isClosed,
            isWon: isClosed && staticProbability === 1,
            isLost: isClosed && staticProbability !== 1
          };
        })
        .sort(function (a, b) { return a.order - b.order; });
      if (!stages.some(function (s) { return s.isWon; })) warnings.push('pipeline_has_no_closed_won_stage:' + p.id);
      if (!stages.some(function (s) { return !s.isClosed; })) warnings.push('pipeline_has_no_open_stages:' + p.id);
      return { id: String(p.id), label: String(p.label || p.id), stages: stages };
    });
  wanted.forEach(function (id) {
    if (!pipelines.some(function (p) { return p.id === id; })) warnings.push('configured_pipeline_not_found:' + id);
  });
  return { pipelines: pipelines, warnings: warnings };
}

function buildDealPropertyList(pipelines) {
  const props = BASE_DEAL_PROPERTIES.slice();
  pipelines.forEach(function (p) {
    p.stages.forEach(function (s) {
      const name = 'hs_date_entered_' + s.id;
      if (props.indexOf(name) === -1) props.push(name);
    });
  });
  return props;
}

function collectDeals(pages) {
  const byId = {};
  (Array.isArray(pages) ? pages : []).forEach(function (page) {
    const results = page && Array.isArray(page.results) ? page.results : [];
    results.forEach(function (deal) {
      if (deal && deal.id !== undefined && !deal.archived) byId[String(deal.id)] = deal;
    });
  });
  return Object.keys(byId).sort().map(function (id) { return byId[id]; });
}

function extractJourney(deal, pipeline) {
  const p = deal.properties || {};
  const stagesById = {};
  pipeline.stages.forEach(function (s) { stagesById[s.id] = s; });
  const events = [];
  const history = deal.propertiesWithHistory && Array.isArray(deal.propertiesWithHistory.dealstage)
    ? deal.propertiesWithHistory.dealstage : null;
  let source = 'none';

  if (history && history.length) {
    history.forEach(function (h) {
      const at = toMs(h && h.timestamp);
      const stageId = h && h.value !== undefined && h.value !== null ? String(h.value) : null;
      if (stageId && stagesById[stageId] && at !== null) events.push({ stageId: stageId, at: at });
    });
    if (events.length) source = 'history';
  }
  if (!events.length) {
    pipeline.stages.forEach(function (s) {
      const at = toMs(p['hs_date_entered_' + s.id]);
      if (at !== null) events.push({ stageId: s.id, at: at });
    });
    if (events.length) source = 'date_entered';
  }

  const currentId = calcBlank(p.dealstage) ? null : String(p.dealstage);
  const current = currentId ? stagesById[currentId] || null : null;
  if (current && !events.some(function (e) { return e.stageId === current.id; })) {
    events.push({ stageId: current.id, at: toMs(p.hs_lastmodifieddate) || toMs(p.createdate) || 0 });
    if (source === 'none') source = 'current_stage_only';
  }

  events.sort(function (a, b) { return a.at - b.at; });
  const visited = [];
  events.forEach(function (e) { if (visited.indexOf(e.stageId) === -1) visited.push(e.stageId); });

  const isClosed = current ? current.isClosed : String(p.hs_is_closed) === 'true';
  const isWon = current ? current.isWon : String(p.hs_is_closed_won) === 'true';
  const homeAmount = toNumber(p.amount_in_home_currency);
  const lastEventAt = events.length ? events[events.length - 1].at : null;
  return {
    id: String(deal.id),
    pipelineId: pipeline.id,
    stageId: current ? current.id : currentId,
    stageKnown: Boolean(current),
    isClosed: isClosed,
    isWon: isWon,
    closeDate: toMs(p.closedate),
    closedAt: isClosed ? (toMs(p.closedate) || lastEventAt) : null,
    amount: homeAmount !== null ? homeAmount : toNumber(p.amount),
    currency: calcBlank(p.deal_currency_code) ? null : String(p.deal_currency_code).toUpperCase(),
    usesHomeCurrency: homeAmount !== null,
    visited: visited,
    source: source
  };
}

function wilsonInterval(successes, n, z) {
  if (!n) return { low: null, high: null };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denominator), high: Math.min(1, (centre + margin) / denominator) };
}

function poolAdjacentViolators(values, weights) {
  // Weighted isotonic regression (non-decreasing). O(n) amortized.
  const blocks = [];
  values.forEach(function (v, i) {
    blocks.push({ sum: v * weights[i], weight: weights[i], count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      blocks.splice(blocks.length - 2, 2, { sum: prev.sum + last.sum, weight: prev.weight + last.weight, count: prev.count + last.count });
    }
  });
  const fitted = [];
  blocks.forEach(function (b) { for (let i = 0; i < b.count; i++) fitted.push(b.sum / b.weight); });
  return fitted;
}

function computeStageStatistics(pipeline, journeys, cfg, nowMs) {
  const cutoff = nowMs - cfg.lookbackDays * DAY_IN_MS;
  const cohort = journeys.filter(function (j) {
    return j.pipelineId === pipeline.id && j.isClosed && j.closedAt !== null && j.closedAt >= cutoff && j.closedAt <= nowMs;
  });
  const cohortWins = cohort.filter(function (j) { return j.isWon; }).length;
  const cohortWinRate = cohort.length ? cohortWins / cohort.length : null;
  const openStages = pipeline.stages.filter(function (s) { return !s.isClosed; });
  const k = cfg.priorStrength;

  const rows = openStages.map(function (stage, index) {
    // "Later" means a later open stage or closed won; moving to closed lost is not advancement.
    const laterIds = pipeline.stages.filter(function (s) { return (!s.isClosed && s.order > stage.order) || s.isWon; }).map(function (s) { return s.id; });
    const next = openStages[index + 1] || null;
    const reached = cohort.filter(function (j) { return j.visited.indexOf(stage.id) !== -1; });
    const wins = reached.filter(function (j) { return j.isWon; }).length;
    const advanced = reached.filter(function (j) {
      return j.isWon || j.visited.some(function (id) { return id !== stage.id && laterIds.indexOf(id) !== -1; });
    }).length;
    const reachedNext = next ? reached.filter(function (j) { return j.visited.indexOf(next.id) !== -1; }).length : null;
    const prior = stage.staticProbability !== null ? stage.staticProbability : (cohortWinRate !== null ? cohortWinRate : 0.5);
    const n = reached.length;
    const smoothed = n + k > 0 ? (wins + k * prior) / (n + k) : prior;
    const ci = wilsonInterval(wins, n, WILSON_Z_90);
    return {
      stageId: stage.id,
      label: stage.label,
      order: stage.order,
      type: 'open',
      staticProbability: stage.staticProbability,
      priorUsed: prior,
      observedWinRate: n ? wins / n : null,
      smoothedProbability: smoothed,
      probability: smoothed,
      ci90: ci,
      sampleSize: n,
      wins: wins,
      nextStageId: next ? next.id : null,
      nextStageConversion: next && n ? reachedNext / n : null,
      advancementRate: n ? advanced / n : null,
      lowConfidence: n < cfg.minSampleSize,
      monotonicAdjusted: false
    };
  });

  if (cfg.enforceMonotonic && rows.length > 1) {
    const fitted = poolAdjacentViolators(
      rows.map(function (r) { return r.smoothedProbability; }),
      rows.map(function (r) { return Math.max(r.sampleSize + k, 1e-6); })
    );
    rows.forEach(function (r, i) {
      r.probability = fitted[i];
      r.monotonicAdjusted = Math.abs(fitted[i] - r.smoothedProbability) > 1e-9;
    });
  }

  pipeline.stages.filter(function (s) { return s.isClosed; }).forEach(function (s) {
    rows.push({
      stageId: s.id, label: s.label, order: s.order, type: s.isWon ? 'closed_won' : 'closed_lost',
      staticProbability: s.staticProbability, priorUsed: null, observedWinRate: null, smoothedProbability: s.isWon ? 1 : 0,
      probability: s.isWon ? 1 : 0, ci90: { low: null, high: null }, sampleSize: null, wins: null,
      nextStageId: null, nextStageConversion: null, advancementRate: null, lowConfidence: false, monotonicAdjusted: false
    });
  });

  return {
    cohortSize: cohort.length,
    cohortWins: cohortWins,
    cohortWinRate: cohortWinRate,
    historyCoverage: cohort.length ? cohort.filter(function (j) { return j.source === 'history' || j.source === 'date_entered'; }).length / cohort.length : null,
    stages: rows
  };
}

function zonedParts(ms, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).forEach(function (part) { parts[part.type] = part.value; });
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function periodKeyFromParts(year, month, period) {
  return period === 'quarter' ? year + '-Q' + (Math.floor((month - 1) / 3) + 1) : year + '-' + String(month).padStart(2, '0');
}

function periodKey(ms, period, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return periodKeyFromParts(parts.year, parts.month, period);
}

function periodSequence(nowMs, period, count, timeZone) {
  const parts = zonedParts(nowMs, timeZone);
  const step = period === 'quarter' ? 3 : 1;
  let year = parts.year;
  let month = period === 'quarter' ? Math.floor((parts.month - 1) / 3) * 3 + 1 : parts.month;
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(periodKeyFromParts(year, month, period));
    month += step;
    while (month > 12) { month -= 12; year += 1; }
  }
  return keys;
}

function emptyBucket() {
  return { deals: 0, amount: 0, staticWeighted: 0, dynamicWeighted: 0 };
}

function addToBucket(bucket, amount, staticP, dynamicP) {
  bucket.deals += 1;
  if (amount === null) return;
  bucket.amount += amount;
  bucket.staticWeighted += amount * (staticP === null ? 0 : staticP);
  bucket.dynamicWeighted += amount * dynamicP;
}

function computeForecast(pipeline, stats, journeys, cfg, nowMs) {
  const probability = {};
  const staticProbability = {};
  stats.stages.forEach(function (s) {
    probability[s.stageId] = s.probability;
    staticProbability[s.stageId] = s.staticProbability;
  });
  const periods = periodSequence(nowMs, cfg.forecastPeriod, cfg.forecastPeriodsAhead, cfg.reportTimezone);
  const currentPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];
  const byStage = {};
  const byPeriod = {};
  periods.concat(['past_due', 'later', 'unscheduled']).forEach(function (key) { byPeriod[key] = emptyBucket(); });
  const totals = emptyBucket();
  let missingAmount = 0;
  let overdue = 0;
  const currencies = {};

  journeys.filter(function (j) { return j.pipelineId === pipeline.id && !j.isClosed && j.stageKnown; }).forEach(function (j) {
    const dynamicP = probability[j.stageId];
    const staticP = staticProbability[j.stageId];
    if (dynamicP === undefined) return;
    if (j.amount === null) missingAmount += 1;
    if (!j.usesHomeCurrency && j.currency) currencies[j.currency] = true;
    if (j.closeDate !== null && j.closeDate < nowMs) overdue += 1;
    byStage[j.stageId] = byStage[j.stageId] || emptyBucket();
    addToBucket(byStage[j.stageId], j.amount, staticP, dynamicP);
    addToBucket(totals, j.amount, staticP, dynamicP);
    let key = 'unscheduled';
    if (j.closeDate !== null) {
      const k = periodKey(j.closeDate, cfg.forecastPeriod, cfg.reportTimezone);
      key = k < currentPeriod ? 'past_due' : (k > lastPeriod ? 'later' : k);
    }
    addToBucket(byPeriod[key], j.amount, staticP, dynamicP);
  });

  return {
    totals: totals,
    byStage: byStage,
    byPeriod: byPeriod,
    periodOrder: ['past_due'].concat(periods, ['later', 'unscheduled']),
    dealsMissingAmount: missingAmount,
    overdueOpenDeals: overdue,
    mixedCurrencies: Object.keys(currencies).length > 1
  };
}

function runDateOf(nowMs, timeZone) {
  const parts = zonedParts(nowMs, timeZone);
  return parts.year + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

function buildSheetRows(results, cfg, runAt, runDate) {
  const summary = [];
  const stages = [];
  const periods = [];
  const money = function (v) { return round(v, 2); };
  const prob = function (v) { return round(v, 4); };

  const summaryRow = function (id, name, totals, extra) {
    const delta = totals.dynamicWeighted - totals.staticWeighted;
    return Object.assign({
      row_key: runDate + '|' + id,
      run_date: runDate,
      run_at: runAt,
      write_mode: cfg.writeMode,
      pipeline_id: sheetText(id),
      pipeline_name: sheetText(name),
      open_deals: totals.deals,
      open_amount: money(totals.amount),
      static_weighted_forecast: money(totals.staticWeighted),
      dynamic_weighted_forecast: money(totals.dynamicWeighted),
      forecast_delta: money(delta),
      forecast_delta_pct: totals.staticWeighted ? prob(delta / totals.staticWeighted) : null,
      lookback_days: cfg.lookbackDays,
      prior_strength: cfg.priorStrength
    }, extra);
  };

  const grand = emptyBucket();
  let grandCohort = 0;
  let grandWins = 0;
  let grandMissing = 0;
  let grandOverdue = 0;
  let grandLow = 0;

  results.forEach(function (r) {
    const f = r.forecast;
    const s = r.stats;
    const lowConfidence = s.stages.filter(function (st) { return st.type === 'open' && st.lowConfidence; }).length;
    summary.push(summaryRow(r.pipeline.id, r.pipeline.label, f.totals, {
      cohort_closed_deals: s.cohortSize,
      cohort_win_rate: prob(s.cohortWinRate),
      low_confidence_stages: lowConfidence,
      deals_missing_amount: f.dealsMissingAmount,
      overdue_open_deals: f.overdueOpenDeals,
      history_coverage_pct: prob(s.historyCoverage)
    }));
    ['deals', 'amount', 'staticWeighted', 'dynamicWeighted'].forEach(function (k) { grand[k] += f.totals[k]; });
    grandCohort += s.cohortSize;
    grandWins += s.cohortWins;
    grandMissing += f.dealsMissingAmount;
    grandOverdue += f.overdueOpenDeals;
    grandLow += lowConfidence;

    s.stages.forEach(function (st) {
      const bucket = f.byStage[st.stageId] || emptyBucket();
      stages.push({
        row_key: runDate + '|' + r.pipeline.id + '|' + st.stageId,
        run_date: runDate,
        pipeline_id: sheetText(r.pipeline.id),
        pipeline_name: sheetText(r.pipeline.label),
        stage_order: st.order,
        stage_id: sheetText(st.stageId),
        stage_name: sheetText(st.label),
        static_probability: prob(st.staticProbability),
        observed_win_rate: prob(st.observedWinRate),
        smoothed_probability: prob(st.smoothedProbability),
        dynamic_probability: prob(st.probability),
        ci90_low: prob(st.ci90.low),
        ci90_high: prob(st.ci90.high),
        sample_size: st.sampleSize,
        wins: st.wins,
        next_stage_conversion: prob(st.nextStageConversion),
        advancement_rate: prob(st.advancementRate),
        low_confidence: st.lowConfidence,
        monotonic_adjusted: st.monotonicAdjusted,
        open_deals: bucket.deals,
        open_amount: money(bucket.amount),
        static_weighted: money(bucket.staticWeighted),
        dynamic_weighted: money(bucket.dynamicWeighted)
      });
    });

    f.periodOrder.forEach(function (key) {
      const bucket = f.byPeriod[key];
      periods.push({
        row_key: runDate + '|' + r.pipeline.id + '|' + key,
        run_date: runDate,
        pipeline_id: sheetText(r.pipeline.id),
        pipeline_name: sheetText(r.pipeline.label),
        period: key,
        open_deals: bucket.deals,
        open_amount: money(bucket.amount),
        static_weighted: money(bucket.staticWeighted),
        dynamic_weighted: money(bucket.dynamicWeighted)
      });
    });
  });

  if (results.length > 1) {
    summary.push(summaryRow(ALL_PIPELINES_ID, 'All pipelines', grand, {
      cohort_closed_deals: grandCohort,
      cohort_win_rate: grandCohort ? prob(grandWins / grandCohort) : null,
      low_confidence_stages: grandLow,
      deals_missing_amount: grandMissing,
      overdue_open_deals: grandOverdue,
      history_coverage_pct: null
    }));
  }
  return { summary: summary, stages: stages, periods: periods };
}

function calculateForecast(input) {
  const cfg = input.config;
  const nowMs = input.now instanceof Date ? input.now.getTime() : Date.now();
  const normalized = normalizePipelines(input.pipelinesBody, cfg);
  const warnings = normalized.warnings.slice();
  if (!normalized.pipelines.length) throw new Error('No deal pipelines available to forecast (check PIPELINE_IDS and the pipelines response).');

  const pipelineById = {};
  normalized.pipelines.forEach(function (p) { pipelineById[p.id] = p; });
  const deals = collectDeals(input.dealPages);
  const journeys = [];
  let otherPipeline = 0;
  let unknownStage = 0;
  deals.forEach(function (deal) {
    const pipelineId = deal.properties && !calcBlank(deal.properties.pipeline) ? String(deal.properties.pipeline) : null;
    const pipeline = pipelineId ? pipelineById[pipelineId] : null;
    if (!pipeline) { otherPipeline += 1; return; }
    const journey = extractJourney(deal, pipeline);
    if (!journey.stageKnown) unknownStage += 1;
    journeys.push(journey);
  });
  if (unknownStage) warnings.push('deals_in_unknown_or_archived_stage:' + unknownStage);
  if (input.truncated) warnings.push('deal_fetch_truncated_at_max_pages');

  const results = normalized.pipelines.map(function (pipeline) {
    const stats = computeStageStatistics(pipeline, journeys, cfg, nowMs);
    const forecast = computeForecast(pipeline, stats, journeys, cfg, nowMs);
    if (stats.cohortSize === 0) warnings.push('no_closed_deals_in_lookback:' + pipeline.id);
    if (forecast.mixedCurrencies) warnings.push('mixed_deal_currencies_without_home_currency_amount:' + pipeline.id);
    return { pipeline: { id: pipeline.id, label: pipeline.label }, stats: stats, forecast: forecast };
  });

  const runAt = new Date(nowMs).toISOString();
  const runDate = runDateOf(nowMs, cfg.reportTimezone);
  return {
    runAt: runAt,
    runDate: runDate,
    writeMode: cfg.writeMode,
    dealsFetched: deals.length,
    dealsOutsideSelectedPipelines: otherPipeline,
    pipelines: results,
    rows: buildSheetRows(results, cfg, runAt, runDate),
    columns: { summary: SUMMARY_COLUMNS, stages: STAGE_COLUMNS, periods: PERIOD_COLUMNS },
    warnings: warnings
  };
}
// </n8n-core:calculator>

module.exports = {
  BASE_DEAL_PROPERTIES,
  SUMMARY_COLUMNS,
  STAGE_COLUMNS,
  PERIOD_COLUMNS,
  ALL_PIPELINES_ID,
  toMs,
  round,
  sheetText,
  normalizePipelines,
  buildDealPropertyList,
  collectDeals,
  extractJourney,
  wilsonInterval,
  poolAdjacentViolators,
  computeStageStatistics,
  periodKey,
  periodSequence,
  computeForecast,
  buildSheetRows,
  calculateForecast
};
