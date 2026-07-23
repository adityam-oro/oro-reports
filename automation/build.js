// Daily rebuild of the CO Walk-ins Report.
// Pulls fresh data from Oro 2.0 (walkin_lead) and Quali (lead/rm_caller/loan_history) via the
// Metabase API, applies the same cleaning/bucketing logic as the report, and writes co_walkins_report.html.
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
           wl.type::text, wl.questionnaire->>'purposeOfVisit' AS reason, u.role_name, wl.mobile_number
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
      SELECT l.id, l.caller_id, rc.caller_type, rc.caller_name
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
    leadById[r[0]] = { caller_type: r[2] || 'UNASSIGNED', caller_name: r[3] || null };
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

  // Reason bucketing — see the "What to Follow up!" table in the how-it-works guide for the full mapping.
  const REASON_BUCKETS = [
    { label: 'New Gold Loan', match: ['gold_loan', 'gold loan enquiry', 'enquiry'], followupNeeded: true, isGoldLoan: true },
    { label: 'Gold Sale', match: ['gold_sale', 'gold sale', 'sale enquiry'], followupNeeded: true, isGoldLoan: false },
    { label: 'Renewal / Top-up', match: ['renewal', 'manual renewal', 'manual renewable', 'renwal', 'renewel', 'rewewable process', 'renewable', 'top up', 'topup', 'gold loan top up purpose', 'excess amount', 'excess', 'part payment'], followupNeeded: true, isGoldLoan: false },
    { label: 'Takeover', match: ['takeover', 'take over information', 'take over details', 'takeover details enquiry'], followupNeeded: true, isGoldLoan: false },
    { label: 'Gold Valuation', match: ['gold_valuation'], followupNeeded: true, isGoldLoan: false },
    { label: 'Release / Closing', match: ['release', 'part release', 'gold release', 'partrelease', 'gold loan release purpose', 'closing', 'closing payment', 'loan close', 'transfer loan on co borrower name'], followupNeeded: false, isGoldLoan: false },
    { label: 'Service', match: ['service', 'servive'], followupNeeded: false, isGoldLoan: false },
    { label: 'Business', match: ['business', 'business partner agreement', 'branch event purpose'], followupNeeded: true, isGoldLoan: false },
  ];
  const REASON_LOOKUP = {};
  REASON_BUCKETS.forEach(b => b.match.forEach(m => (REASON_LOOKUP[m] = b)));
  const NOT_SPECIFIED = { label: 'Not Specified / Other', followupNeeded: true, isGoldLoan: false };
  function bucketReason(reason) {
    return REASON_LOOKUP[(reason || '').toLowerCase().trim()] || NOT_SPECIFIED;
  }
  const REASON_LABELS = REASON_BUCKETS.map(b => b.label).concat([NOT_SPECIFIED.label]);
  const FOLLOWUP_NEEDED = REASON_BUCKETS.map(b => b.followupNeeded).concat([NOT_SPECIFIED.followupNeeded]);
  const reasonCodeOf = label => REASON_LABELS.indexOf(label);

  const WALKINS = [];
  wl.forEach(([id, city, office, created_at, quali_lead_id, type, reason]) => {
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
    const bucket = bucketReason(reason);
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

async function postSlackSummary(WALKINS, ist) {
  const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL not set — skipping Slack summary.');
    return;
  }

  const today = ist.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const mtd = WALKINS.filter(w => w.day >= monthStart && w.day <= today);

  const total = mtd.length;
  const withRE = mtd.filter(w => w.isRE).length;
  const goldLoanMtd = mtd.filter(w => w.isGoldLoan);
  const completedGL = goldLoanMtd.filter(w => w.completedVia).length;

  const byCity = {};
  mtd.forEach(w => { byCity[w.city] = (byCity[w.city] || 0) + 1; });
  const topCities = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const byOffice = {};
  mtd.forEach(w => {
    const key = `${w.office} (${w.city})`;
    byOffice[key] = (byOffice[key] || 0) + 1;
  });
  const topOffice = Object.entries(byOffice).sort((a, b) => b[1] - a[1])[0];

  const reByCity = {};
  mtd.forEach(w => {
    reByCity[w.city] = reByCity[w.city] || { total: 0, re: 0 };
    reByCity[w.city].total++;
    if (w.isRE) reByCity[w.city].re++;
  });
  const reRates = Object.entries(reByCity)
    .filter(([, v]) => v.total >= 5)
    .map(([city, v]) => ({ city, rate: pct(v.re, v.total) }));
  const lowestRE = reRates.sort((a, b) => a.rate - b.rate)[0];

  const byReason = {};
  mtd.forEach(w => { byReason[w.reasonLabel] = (byReason[w.reasonLabel] || 0) + 1; });
  const topReason = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];

  const insights = [];
  if (topOffice) insights.push(`Busiest office MTD: *${topOffice[0]}* with ${topOffice[1]} walk-ins.`);
  if (topReason) insights.push(`Most common reason: *${topReason[0]}* (${topReason[1]} of ${total}).`);
  if (lowestRE) insights.push(`Lowest branch-RE ownership: *${lowestRE.city}* at ${lowestRE.rate}%.`);

  const cityLines = topCities.map(([city, n]) => `• ${city}: ${n}`).join('\n');
  const insightLines = insights.map(i => `• ${i}`).join('\n');

  const text = [
    `*CO Walk-ins Report — MTD Summary (${monthStart} to ${today})*`,
    ``,
    `*Total walk-ins (MTD):* ${total}`,
    `*% With Branch RE:* ${pct(withRE, total)}%`,
    `*% Loan Completed (Gold Loan only):* ${pct(completedGL, goldLoanMtd.length)}%`,
    ``,
    `*Top cities MTD:*`,
    cityLines || '• (no data)',
    ``,
    `*Insights:*`,
    insightLines || '• (no notable patterns)',
    ``,
    `Full report: https://adityam-oro.github.io/oro-reports/co_walkins_report.html`,
  ].join('\n');

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook post failed (${res.status}): ${body.slice(0, 300)}`);
  }
  console.log('Posted MTD summary to Slack.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
