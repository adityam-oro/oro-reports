// Daily rebuild of the CO Walk-ins Report.
// Pulls fresh data from Oro 2.0 (walkin_lead) and Quali (lead/rm_caller) via the
// Metabase API, applies the same cleaning/bucketing logic as the report, and writes co_walkins_report.html.
// Reason/disposition bucketing is derived from Quali's lead.service_category_type (100% populated,
// 7 clean enum values), joined via the same quali_lead_id -> lead.id mapping used for RE-ownership —
// NOT from the old walkin_lead.questionnaire->>'purposeOfVisit'/'reason' free-text JSON, which had huge
// data-quality gaps (e.g. ~98% missing in Chennai under one schema) and is no longer read for bucketing.
// Also posts an MTD summary to Slack via an Incoming Webhook, if configured.
//
// Required environment variables (set as GitHub Actions secrets):
//   METABASE_URL       e.g. https://oro.metabaseapp.com
//   METABASE_API_KEY   an API key created in Metabase Admin > Settings > API Keys
//   ORO2_DB_ID         Metabase database id for "Oro 2.0" (walkin_lead lives here)
//   QUALI_DB_ID        Metabase database id for "Quali-prod" (lead/rm_caller/loan_history live here)
//   SLACK_WEBHOOK_URL  optional — an Incoming Webhook URL for the target Slack channel

const fs = require('fs');
const path = require('path');

const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const ORO2_DB_ID = parseInt(process.env.ORO2_DB_ID, 10);
const QUALI_DB_ID = parseInt(process.env.QUALI_DB_ID, 10);

if (!METABASE_URL || !METABASE_API_KEY || !ORO2_DB_ID || !QUALI_DB_ID) {
  console.error('Missing required environment variables. Need METABASE_URL, METABASE_API_KEY, ORO2_DB_ID, QUALI_DB_ID.');
  process.exit(1);
}

async function runQuery(databaseId, query) {
  const res = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
    body: JSON.stringify({ database: databaseId, type: 'native', native: { query } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metabase query failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (!json.data || !json.data.rows) throw new Error(`Unexpected Metabase response shape: ${JSON.stringify(json).slice(0, 300)}`);
  return json.data.rows;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log('Fetching walk-ins from Oro 2.0...');
  const walkinQuery = `
    SELECT wl.id, ci.name AS city, co.name AS office, wl.created_at, wl.quali_lead_id,
           wl.type::text, wl.questionnaire->>'purposeOfVisit' AS legacy_reason_unused, u.role_name, wl.mobile_number
    FROM walkin_lead wl
    LEFT JOIN cluster_office co ON co.id = wl.cluster_office_id
    LEFT JOIN city ci ON ci.id = co.city_id
    LEFT JOIN users u ON u.id = wl.submitted_by
    WHERE wl.lead_type = 'CO_WALKIN'
    ORDER BY wl.id
  `;
  const wl = await runQuery(ORO2_DB_ID, walkinQuery);
  console.log(`  ${wl.length} walk-in rows`);

  // Test/dummy walk-ins: dev/system submitter, or reason literally says test/testing.
  const TEST_IDS = new Set(wl.filter(r => {
    const role = (r[7] || '').toLowerCase();
    const reason = (r[6] || '').toLowerCase();
    return role.includes('test') || role.includes('dev') || reason.includes('test');
  }).map(r => r[0]));

  const idSet = new Set();
  wl.forEach(r => {
    if (TEST_IDS.has(r[0])) return;
    if (!r[4]) return;
    const n = parseInt(String(r[4]).replace(/[^0-9]/g, ''), 10);
    if (n) idSet.add(n);
  });
  const ids = Array.from(idSet);
  console.log(`Fetching ${ids.length} linked Quali leads (test walk-ins excluded: ${TEST_IDS.size})...`);

  // NOTE: loan-completion is NO LONGER derived from this Quali query — Quali's loan_history table is a
  // frozen historical snapshot (stopped updating in 2024/2025) and cannot tell us whether a loan actually
  // happened after the walk-in. This query is now only used for caller ownership (isRE/reCallerName).
  let leadRows = [];
  for (const batch of chunk(ids, 400)) {
    const q = `
      SELECT l.id, l.caller_id, rc.caller_type, rc.caller_name, l.service_category_type
      FROM lead l
      LEFT JOIN rm_caller rc ON rc.id = l.caller_id
      WHERE l.id IN (${batch.join(',')})
    `;
    const rows = await runQuery(QUALI_DB_ID, q);
    leadRows = leadRows.concat(rows);
  }
  console.log(`  ${leadRows.length} lead rows`);

  const leadById = {};
  leadRows.forEach(r => {
    leadById[r[0]] = { caller_type: r[2] || 'UNASSIGNED', caller_name: r[3] || null, service_category_type: r[4] || null };
  });

  // ---- Loan-completion detection (Oro 2.0 only) ----
  // walkin_lead.mobile_number is a bare 10-digit string; users.mobile_number is stored as '+91XXXXXXXXXX'.
  // Match on that, restricted to CUSTOMER users, then look up their loans by customer_auth_id and use
  // loans.orocorp_approved_at (best-populated live "loan happened" timestamp) as the completion event.
  // loans.loan_subtype classifies the completion as Fresh vs Takeover (see COMPLETION_TYPE_BY_WALKIN_ID below).
  console.log('Fetching customer users + loans from Oro 2.0 for conversion detection...');
  const mobileSet = new Set();
  wl.forEach(r => {
    if (TEST_IDS.has(r[0])) return;
    const mobile = (r[8] || '').replace(/[^0-9]/g, '');
    if (mobile) mobileSet.add(mobile);
  });
  const mobiles = Array.from(mobileSet);

  let userRows = [];
  for (const batch of chunk(mobiles, 400)) {
    const inList = batch.map(m => `'+91${m}'`).join(',');
    const q = `
      SELECT id, mobile_number, auth_id
      FROM users
      WHERE role_name = 'CUSTOMER' AND mobile_number IN (${inList})
    `;
    const rows = await runQuery(ORO2_DB_ID, q);
    userRows = userRows.concat(rows);
  }
  console.log(`  ${userRows.length} matching customer users`);

  // mobile (bare 10-digit) -> auth_id
  const authIdByMobile = {};
  userRows.forEach(r => {
    const mobile = (r[1] || '').replace(/[^0-9]/g, '').slice(-10);
    if (mobile) authIdByMobile[mobile] = r[2];
  });
  const authIds = Array.from(new Set(Object.values(authIdByMobile).filter(Boolean)));

  let loanRows = [];
  for (const batch of chunk(authIds, 400)) {
    const inList = batch.map(a => `'${a}'`).join(',');
    const q = `
      SELECT customer_auth_id, orocorp_approved_at, loan_subtype
      FROM loans
      WHERE customer_auth_id IN (${inList}) AND orocorp_approved_at IS NOT NULL
    `;
    const rows = await runQuery(ORO2_DB_ID, q);
    loanRows = loanRows.concat(rows);
  }
  console.log(`  ${loanRows.length} approved loans for matched customers`);

  // auth_id -> list of { time: approved_at, subtype: loan_subtype } objects.
  // loan_subtype = 'TAKEOVER' -> Takeover; NULL/'DC'/'RENEWAL_LOAN'/'TOPUP_LOAN' (all rare) -> Fresh.
  const loansByAuthId = {};
  loanRows.forEach(r => {
    if (!r[0] || !r[1]) return;
    loansByAuthId[r[0]] = loansByAuthId[r[0]] || [];
    loansByAuthId[r[0]].push({ time: r[1], subtype: r[2] });
  });

  // Group walk-ins by mobile number, then greedily pair each loan with its single nearest-preceding
  // walk-in (last-touch dedup) so one real loan can't be credited to multiple walk-ins, and one walk-in
  // can't double-claim two loans meant for different (closer) walk-ins.
  const walkinsByMobile = {};
  wl.forEach(r => {
    const id = r[0];
    if (TEST_IDS.has(id)) return;
    const mobile = (r[8] || '').replace(/[^0-9]/g, '').slice(-10);
    if (!mobile) return;
    walkinsByMobile[mobile] = walkinsByMobile[mobile] || [];
    walkinsByMobile[mobile].push({ id, created_at: r[3] });
  });

  const CONVERTED_IDS = new Set();
  const COMPLETION_TYPE_BY_WALKIN_ID = new Map(); // walk-in id -> 'FRESH' | 'TAKEOVER'
  Object.keys(walkinsByMobile).forEach(mobile => {
    const authId = authIdByMobile[mobile];
    if (!authId) return;
    const loanEntries = loansByAuthId[authId];
    if (!loanEntries || !loanEntries.length) return;

    const walkins = walkinsByMobile[mobile].slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const loans = loanEntries.slice().sort((a, b) => a.time.localeCompare(b.time));
    const claimed = new Set(); // walk-in ids already claimed by a (closer) loan

    // For each loan, find its nearest-preceding, not-yet-claimed walk-in.
    loans.forEach(loan => {
      let best = null;
      for (const w of walkins) {
        if (w.created_at > loan.time) break; // walk-ins sorted ascending; stop once past the loan time
        if (claimed.has(w.id)) continue;
        best = w; // keep advancing to get the closest-preceding (last) eligible walk-in
      }
      if (best) {
        claimed.add(best.id);
        CONVERTED_IDS.add(best.id);
        COMPLETION_TYPE_BY_WALKIN_ID.set(best.id, loan.subtype === 'TAKEOVER' ? 'TAKEOVER' : 'FRESH');
      }
    });
  });

  // Reason/disposition bucketing — driven by Quali's lead.service_category_type (100% populated, 7 clean
  // enum values), NOT the old walkin_lead.questionnaire free-text JSON. See header comment for rationale.
  const REASON_BUCKETS = [
    { label: 'New Gold Loan', match: ['GOLD_LOAN'], followupNeeded: true, isGoldLoan: true },
    { label: 'Gold Sale', match: ['GOLD_SALE'], followupNeeded: true, isGoldLoan: false },
    { label: 'Gold Valuation', match: ['GOLD_VALUATION'], followupNeeded: true, isGoldLoan: false },
    { label: 'Community Activity', match: ['COMMUNITY_ACTIVITY'], followupNeeded: true, isGoldLoan: false },
    { label: 'Support Query', match: ['SUPPORT_QUERY'], followupNeeded: false, isGoldLoan: false },
    { label: 'Release Query', match: ['RELEASE_QUERY'], followupNeeded: false, isGoldLoan: false },
  ];
  const REASON_LOOKUP = {};
  REASON_BUCKETS.forEach(b => b.match.forEach(m => (REASON_LOOKUP[m] = b)));
  const NOT_SPECIFIED = { label: 'Not Specified / Other', followupNeeded: true, isGoldLoan: false }; // covers 'OTHERS' and any null/unmatched
  function bucketReason(lead) {
    const type = lead && lead.service_category_type ? String(lead.service_category_type).toUpperCase() : null;
    if (!type) return NOT_SPECIFIED;
    return REASON_LOOKUP[type] || NOT_SPECIFIED;
  }
  const REASON_LABELS = REASON_BUCKETS.map(b => b.label).concat([NOT_SPECIFIED.label]);
  const FOLLOWUP_NEEDED = REASON_BUCKETS.map(b => b.followupNeeded).concat([NOT_SPECIFIED.followupNeeded]);
  const reasonCodeOf = label => REASON_LABELS.indexOf(label);

  const WALKINS = [];
  wl.forEach(([id, city, office, created_at, quali_lead_id, type]) => {
    if (TEST_IDS.has(id)) return;
    let lead = null;
    if (quali_lead_id) {
      const n = parseInt(String(quali_lead_id).replace(/[^0-9]/g, ''), 10);
      if (n) lead = leadById[n];
    }
    let callerType = lead ? lead.caller_type : 'UNASSIGNED';
    const callerName = lead ? lead.caller_name : null;
    if (callerType === 'RE_CALLER' && callerName && callerName.toLowerCase().includes('test')) callerType = 'UNASSIGNED';

    // Loan-completion: last-touch-deduped match against Oro 2.0 loans (see CONVERTED_IDS above), not the
    // stale Quali loan_history join this used to rely on. FRESH/TAKEOVER split comes from loans.loan_subtype
    // (see COMPLETION_TYPE_BY_WALKIN_ID above): 'TAKEOVER' -> Takeover, everything else -> Fresh.
    const converted = CONVERTED_IDS.has(id);
    const completedVia = converted ? (COMPLETION_TYPE_BY_WALKIN_ID.get(id) || 'FRESH') : null;
    const bucket = bucketReason(lead);
    const day = created_at.slice(0, 10);
    WALKINS.push({
      city, office, day, type,
      reasonLabel: bucket.label, isGoldLoan: bucket.isGoldLoan,
      isRE: callerType === 'RE_CALLER', reCallerName: callerType === 'RE_CALLER' ? (callerName || 'Unnamed RE') : null,
      converted, completedVia,
    });
  });
  console.log(`  ${WALKINS.length} real walk-ins after cleanup`);

  const CITY_LIST = Array.from(new Set(WALKINS.map(w => w.city)));
  const OFFICE_LIST = Array.from(new Set(WALKINS.map(w => w.office)));
  const RE_NAME_LIST = Array.from(new Set(WALKINS.filter(w => w.reCallerName).map(w => w.reCallerName)));

  const ROWS = WALKINS.map(w => [
    CITY_LIST.indexOf(w.city), OFFICE_LIST.indexOf(w.office), w.day, w.type === 'EXISTING' ? 1 : 0,
    reasonCodeOf(w.reasonLabel), w.isGoldLoan ? 1 : 0, w.isRE ? 1 : 0,
    w.reCallerName ? RE_NAME_LIST.indexOf(w.reCallerName) : -1,
    w.completedVia === 'FRESH' ? 1 : w.completedVia === 'TAKEOVER' ? 2 : 0,
  ]);

  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  const refreshedAt = ist.toISOString().slice(0, 16).replace('T', 'T') + ' IST';

  let template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  template = template
    .replace('__REFRESHED_AT__', refreshedAt)
    .replace('__CITY_LIST__', JSON.stringify(CITY_LIST))
    .replace('__OFFICE_LIST__', JSON.stringify(OFFICE_LIST))
    .replace('__RE_NAME_LIST__', JSON.stringify(RE_NAME_LIST))
    .replace('__REASON_LABELS__', JSON.stringify(REASON_LABELS))
    .replace('__FOLLOWUP_NEEDED__', JSON.stringify(FOLLOWUP_NEEDED))
    .replace('__ROWS__', JSON.stringify(ROWS));

  fs.writeFileSync(path.join(__dirname, '..', 'co_walkins_report.html'), template);
  console.log(`Wrote co_walkins_report.html — ${ROWS.length} walk-ins, refreshed ${refreshedAt}`);

  await postSlackSummary(WALKINS, ist);
}

function pct(part, total) { return total ? Math.round((part / total) * 1000) / 10 : 0; }

// Reason buckets in fixed report order, with abbreviated table headers.
const REASON_COLUMNS = [
  { label: 'New Gold Loan', header: 'NewGL' },
  { label: 'Gold Sale', header: 'GoldSale' },
  { label: 'Gold Valuation', header: 'Valuation' },
  { label: 'Community Activity', header: 'CommActiv' },
  { label: 'Support Query', header: 'Support' },
  { label: 'Release Query', header: 'Release' },
  { label: 'Not Specified / Other', header: 'Other' },
];

// A "potential customer" completion: converted=true, excluding Support/Release queries (same scope used
// throughout the rest of this report / template.html's buildConversion).
function isPotentialCompletion(w) {
  return w.converted && w.reasonLabel !== 'Support Query' && w.reasonLabel !== 'Release Query';
}

// Build a fixed-width plain-text table (for a Slack code block) from column defs + rows.
// cols: [{ header, align: 'left'|'right', getValue: row => string }]
// rows: array of row objects (already includes the trailing Total row, if any).
function buildFixedWidthTable(cols, rows) {
  const cellStrings = rows.map(row => cols.map(c => c.getValue(row)));
  const widths = cols.map((c, i) => Math.max(c.header.length, ...cellStrings.map(r => r[i].length)));
  const pad = (str, width, align) => (align === 'right' ? str.padStart(width) : str.padEnd(width));
  const headerLine = cols.map((c, i) => pad(c.header, widths[i], c.align)).join('  ').trimEnd();
  const bodyLines = cellStrings.map(r => cols.map((c, i) => pad(r[i], widths[i], c.align)).join('  ').trimEnd());
  return [headerLine, ...bodyLines].join('\n');
}

// Per-city MTD rollup for table 2 (City / Walk-ins / %RE / Completed / %Compl / Fresh / Takeover).
function buildCityRollup(mtd) {
  const byCity = {};
  mtd.forEach(w => {
    byCity[w.city] = byCity[w.city] || { city: w.city, walkins: 0, re: 0, completed: 0, fresh: 0, takeover: 0 };
    const c = byCity[w.city];
    c.walkins++;
    if (w.isRE) c.re++;
    if (isPotentialCompletion(w)) {
      c.completed++;
      if (w.completedVia === 'TAKEOVER') c.takeover++;
      else c.fresh++;
    }
  });
  return Object.values(byCity).sort((a, b) => b.walkins - a.walkins);
}

function buildCityRollupTableText(mtd) {
  const rows = buildCityRollup(mtd);
  const totalRow = rows.reduce(
    (acc, r) => {
      acc.walkins += r.walkins; acc.re += r.re; acc.completed += r.completed;
      acc.fresh += r.fresh; acc.takeover += r.takeover;
      return acc;
    },
    { city: 'Total', walkins: 0, re: 0, completed: 0, fresh: 0, takeover: 0 }
  );
  const displayRows = rows.concat([totalRow]);

  const cols = [
    { header: 'City', align: 'left', getValue: r => (r.city === 'Total' ? `▶ ${r.city}` : r.city) },
    { header: 'Walk-ins', align: 'right', getValue: r => String(r.walkins) },
    { header: '%RE', align: 'right', getValue: r => `${pct(r.re, r.walkins)}%` },
    { header: 'Completed', align: 'right', getValue: r => String(r.completed) },
    { header: '%Compl', align: 'right', getValue: r => `${pct(r.completed, r.walkins)}%` },
    { header: 'Fresh', align: 'right', getValue: r => String(r.fresh) },
    { header: 'Takeover', align: 'right', getValue: r => String(r.takeover) },
  ];
  return { text: buildFixedWidthTable(cols, displayRows), cityOrder: rows.map(r => r.city), grandTotal: totalRow.walkins };
}

// City x reason count table (used for both MTD and yesterday scopes).
function buildCityReasonTableText(subset, cityOrder) {
  const byCity = {};
  subset.forEach(w => {
    byCity[w.city] = byCity[w.city] || { city: w.city, counts: {}, total: 0 };
    const c = byCity[w.city];
    c.counts[w.reasonLabel] = (c.counts[w.reasonLabel] || 0) + 1;
    c.total++;
  });

  // Preserve the given city order (e.g. MTD walk-ins-descending order) but only cities present in `subset`;
  // append any cities present in subset but missing from cityOrder (shouldn't normally happen for MTD table,
  // but keeps the "yesterday" table correct in case of an office active only on that day).
  const orderedCities = (cityOrder || []).filter(c => byCity[c]);
  Object.keys(byCity).forEach(c => { if (!orderedCities.includes(c)) orderedCities.push(c); });

  if (!orderedCities.length) return { text: null, grandTotal: 0 };

  const rows = orderedCities.map(c => byCity[c]);
  const totalRow = { city: 'Total', counts: {}, total: 0 };
  REASON_COLUMNS.forEach(rc => {
    totalRow.counts[rc.label] = rows.reduce((sum, r) => sum + (r.counts[rc.label] || 0), 0);
  });
  totalRow.total = rows.reduce((sum, r) => sum + r.total, 0);
  const displayRows = rows.concat([totalRow]);

  const cols = [
    { header: 'City', align: 'left', getValue: r => (r.city === 'Total' ? `▶ ${r.city}` : r.city) },
    ...REASON_COLUMNS.map(rc => ({
      header: rc.header, align: 'right', getValue: r => String(r.counts[rc.label] || 0),
    })),
    { header: 'Total', align: 'right', getValue: r => String(r.total) },
  ];
  return { text: buildFixedWidthTable(cols, displayRows), grandTotal: totalRow.total };
}

// Historical (all-time, not just MTD) average daily walk-in volume for a given office, used as the
// baseline for the spike-day callout.
function officeHistoricalDailyAverage(WALKINS, office) {
  const rows = WALKINS.filter(w => w.office === office);
  const days = new Set(rows.map(w => w.day));
  if (!days.size) return 0;
  return rows.length / days.size;
}

async function postSlackSummary(WALKINS, ist) {
  const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL not set — skipping Slack summary.');
    return;
  }

  const today = ist.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const mtd = WALKINS.filter(w => w.day >= monthStart && w.day <= today);

  const yesterdayDate = new Date(new Date(today + 'T00:00:00Z').getTime() - 24 * 60 * 60 * 1000);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const yesterdayWalkins = WALKINS.filter(w => w.day === yesterday);

  // ---- Section 1: title ----
  const titleText = `*CO Walk-ins Report — Daily Digest (${today})*`;

  // ---- Section 2: MTD table by city ----
  const cityRollup = buildCityRollupTableText(mtd);
  const section2Text = [`*MTD — Walk-ins by City*`, '```', cityRollup.text, '```'].join('\n');

  // ---- Section 3: MTD table by city x reason ----
  const mtdReasonTable = buildCityReasonTableText(mtd, cityRollup.cityOrder);
  console.log(`[verify] MTD walk-ins: overall=${mtd.length}, city-rollup total=${cityRollup.grandTotal}, city x reason total=${mtdReasonTable.grandTotal}`);
  if (mtdReasonTable.grandTotal !== mtd.length || cityRollup.grandTotal !== mtd.length) {
    console.warn('[verify] WARNING: MTD table grand totals do not match overall MTD walk-in count!');
  }
  const section3Text = [`*MTD — Walk-ins by City x Reason*`, '```', mtdReasonTable.text, '```'].join('\n');

  // ---- Section 4: yesterday table by city x reason ----
  const yesterdayReasonTable = buildCityReasonTableText(yesterdayWalkins, cityRollup.cityOrder);
  console.log(`[verify] Yesterday (${yesterday}) walk-ins: overall=${yesterdayWalkins.length}, city x reason total=${yesterdayReasonTable.grandTotal}`);
  const section4Text = yesterdayWalkins.length
    ? [`*Yesterday (${yesterday}) — Walk-ins by City x Reason*`, '```', yesterdayReasonTable.text, '```'].join('\n')
    : [`*Yesterday (${yesterday}) — Walk-ins by City x Reason*`, `_No walk-ins recorded yesterday._`].join('\n');

  // ---- Section 5: insights ----
  const total = mtd.length;

  const byOffice = {};
  mtd.forEach(w => {
    const key = `${w.office}|||${w.city}`;
    byOffice[key] = (byOffice[key] || 0) + 1;
  });
  const topOfficeEntry = Object.entries(byOffice).sort((a, b) => b[1] - a[1])[0];

  const byReason = {};
  mtd.forEach(w => { byReason[w.reasonLabel] = (byReason[w.reasonLabel] || 0) + 1; });
  const topReason = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];

  const reByCity = {};
  mtd.forEach(w => {
    reByCity[w.city] = reByCity[w.city] || { total: 0, re: 0 };
    reByCity[w.city].total++;
    if (w.isRE) reByCity[w.city].re++;
  });
  const reRates = Object.entries(reByCity)
    .filter(([, v]) => v.total >= 5)
    .map(([city, v]) => ({ city, rate: pct(v.re, v.total) }));
  const lowestRE = reRates.slice().sort((a, b) => a.rate - b.rate)[0];
  const highestRE = reRates.slice().sort((a, b) => b.rate - a.rate)[0];

  // Spike callout: office+day combo with the largest MTD daily count, vs that office's all-time daily average.
  const byOfficeDay = {};
  mtd.forEach(w => {
    const key = `${w.office}|||${w.city}|||${w.day}`;
    byOfficeDay[key] = (byOfficeDay[key] || 0) + 1;
  });
  const topOfficeDayEntry = Object.entries(byOfficeDay).sort((a, b) => b[1] - a[1])[0];

  const insights = [];
  if (topOfficeEntry) {
    const [office, city] = topOfficeEntry[0].split('|||');
    insights.push(`Busiest office MTD: *${office}* (${city}) with ${topOfficeEntry[1]} walk-ins.`);
  }
  if (topReason) {
    insights.push(`Most common reason MTD: *${topReason[0]}* — ${topReason[1]} of ${total} (${pct(topReason[1], total)}%).`);
  }
  if (lowestRE && highestRE) {
    insights.push(`Branch-RE ownership spread: lowest *${lowestRE.city}* (${lowestRE.rate}%), highest *${highestRE.city}* (${highestRE.rate}%).`);
  }
  if (topOfficeDayEntry) {
    const [office, city, day] = topOfficeDayEntry[0].split('|||');
    const dayCount = topOfficeDayEntry[1];
    const avg = officeHistoricalDailyAverage(WALKINS, office);
    const multiple = avg > 0 ? dayCount / avg : 0;
    if (avg > 0 && multiple >= 3) {
      const [, , dd] = day.split('-');
      const [, mm] = day.split('-');
      const dateLabel = `${parseInt(mm, 10)}/${parseInt(dd, 10)}`;
      insights.push(`*${office}* (${city}) hit ${dayCount} walk-ins on ${dateLabel} — ~${Math.round(multiple * 10) / 10}x its usual daily average.`);
    }
  }
  const insightLines = insights.map(i => `• ${i}`).join('\n');
  const section5Text = [`*Insights*`, insightLines || '• (no notable patterns)'].join('\n');

  // ---- Section 6: footer ----
  const footerText = `Full report: https://adityam-oro.github.io/oro-reports/co_walkins_report.html`;

  // Slack section blocks cap text.text at ~3000 chars — split into one block per major section (well under
  // the limit individually, and safe regardless of future data volume) rather than one giant block.
  const sectionTexts = [titleText, section2Text, section3Text, section4Text, section5Text, footerText];
  const MAX_BLOCK_LEN = 2900;
  const blocks = [];
  sectionTexts.forEach(t => {
    if (t.length <= MAX_BLOCK_LEN) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t } });
    } else {
      // Extremely defensive fallback: chunk an oversized section into multiple blocks by line.
      const lines = t.split('\n');
      let chunkText = '';
      lines.forEach(line => {
        if ((chunkText + '\n' + line).length > MAX_BLOCK_LEN) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunkText } });
          chunkText = line;
        } else {
          chunkText = chunkText ? `${chunkText}\n${line}` : line;
        }
      });
      if (chunkText) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunkText } });
    }
  });

  const payload = {
    attachments: [{
      color: '#FFA500',
      blocks,
    }],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook post failed (${res.status}): ${body.slice(0, 300)}`);
  }
  console.log('Posted daily digest to Slack.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
