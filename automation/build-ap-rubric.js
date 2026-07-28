// Weekly rebuild of the AP (Appraisal Partner) Rubric Report (runs alongside the SP rubric via GitHub
// Actions). Pulls fresh visit/lead data live from Metabase and rewrites ap_rubric_report.html.
//
// Scoring model (locked in with the user, 2026-07-28): an AP's job is to earn 100 points/day through
// their activities. No daily cap (unlike SP's effort model) — if the numbers look off in practice we can
// add one later. Score = total points earned across the selected months ÷ (100 × working days in that
// range). The Points column in the report shows the average points/day over the selected duration, not a
// raw total.
//   Fresh Loan completed      30 pts   visits.loan_subtype='FRESH_LOAN' AND visit_status='VISIT_COMPLETED'
//   Takeover completed        50 pts   visits.loan_subtype='TAKEOVER'   AND visit_status='VISIT_COMPLETED'
//   Release completed         20 pts   visits.visit_status='RELEASE_VISIT_COMPLETED' AND release_type IN (FULL_RELEASE, PART_RELEASE)
//   Private sale completed    20 pts   visits.visit_status='RELEASE_VISIT_COMPLETED' AND release_type IN (PRIVATE_SALE, PART_PRIVATE_SALE)
//   Gold sale (GBS) completed 30 pts   gbs_visits.status='VISIT_COMPLETED' (separate table/product, agent_auth_id)
//   Visit raised (no completion) 30 pts visits.visit_status='VISIT_CANCELLED' where the AP still did the work
//                                       (traveled, engaged the customer) but it didn't close — cancellation_reason
//                                       shows the customer backed out ("Cancelled by Customer" / "customer_cancelled"),
//                                       NOT system/auto-cancellations ("Auto-cancelled: ..."). A visit that reaches
//                                       VISIT_COMPLETED earns its completion-type points instead, never this bucket too.
//   Lead generation            10 pts  Quali-prod.lead where lead_source AND appointment_booked_by_id both match the
//                                       AP themselves (verified 2026-07-28 — created_by_oro_id alone was inflated by
//                                       a bulk/automated PX_APP channel; this pair is the definition the user
//                                       confirmed is used for the equivalent live Metabase card)
//   Self-sourced Cx Met        20 pts  a lead matching the Lead Generation definition above whose linked sales_visit
//                                       (lead.id -> sales_visit.lead_id) maps to an Oro 2.0 visit
//                                       (sales_visit.id -> visits.sales_visit_id) that reached VISIT_COMPLETED
//
// Bridge Loan Complete was dropped 2026-07-28 — Quali-prod's loan_history.loan_id (the only source with a
// BRL-approval-adjacent timestamp) does not share a key space with Oro 2.0's visits/loans loan_id at all for
// this roster (0 of 3,843 candidate loan_ids matched), so there's no reliable way to date it. Revisit if a
// better link turns up.
//
// Bands: <50% At risk · 50-70% Needs improvement · 70-90% Good performance · >90% Star performer.
// New-joiner exception: an AP who is At risk and still within their first 3 months of joining (by DOJ) is
// held out of every table/stat in the report entirely, not just re-labeled.
//
// Roster: all active Appraisal Partners / Senior Appraisal Partners / Appraisal Leads / Appraisal Trainees
// across every city (no city exclusion for AP, unlike the SP rubric's Chennai exclusion) — 91 of the 135
// active people on the 2026-07-28 HR sheet, resolved to their agent_auth_id via the `users` table (Oro 2.0).
// 44 could not be resolved (mostly 2025/2026 joiners not yet tagged with an appraisal role in that table, or
// people promoted to a managerial role) — hardcoded below, update by hand as more get resolved.
// Cx escalations and recovery-case handling are NOT yet scored — noted in the report as a future addition.
//
// Required environment variables (same GitHub Actions secrets as the SP rubric):
//   METABASE_URL, METABASE_API_KEY, QUALI_DB_ID (Quali-prod: lead/sales_visit),
//   ORO2_DB_ID (Oro 2.0: visits/gbs_visits)

const fs = require('fs');
const path = require('path');

const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const QUALI_DB_ID = parseInt(process.env.QUALI_DB_ID, 10);
const ORO2_DB_ID = parseInt(process.env.ORO2_DB_ID, 10);

if (!METABASE_URL || !METABASE_API_KEY || !QUALI_DB_ID || !ORO2_DB_ID) {
  console.error('Missing required environment variables. Need METABASE_URL, METABASE_API_KEY, QUALI_DB_ID, ORO2_DB_ID.');
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

// [agent_auth_id, name, city, designation, doj] — resolved from the 2026-07-28 HR sheet by matching name
// (and, where needed, city) against Oro 2.0's `users` table. 91 of 135 active APs resolved; the other 44
// (mostly 2025/2026 joiners or people promoted to management) aren't tagged with an appraisal role in
// `users` yet — add them by hand once resolved (see chat history 2026-07-28 for the unresolved-name list).
// doj is null for anyone who joined more than a year ago (irrelevant to the 3-month new-joiner rule) —
// only 2026 joiners need the exact date on file.
const IDENTITY = [
["265","Manikandan R","Chennai","Senior Appraisal Partner",null],["289","Shankar S","Chennai","Senior Appraisal Partner",null],["678","Ramesh AS","Chennai","Senior Appraisal Partner",null],["1718","Tamilazhagan R","Chennai","Senior Appraisal Partner",null],["1572","Lakshmana G","Bengaluru","Appraisal Partner",null],["2169","Praveen Kumar M","Bengaluru","Senior Appraisal Partner",null],["2308","Sachin Danai","Pune","Appraisal Partner",null],["4380","Santhosha K","Bengaluru","Senior Appraisal Partner",null],["5828","Jagadeesha C","Bengaluru","Appraisal Partner",null],["7286","Kaustubh K Kulkarni","Pune","Appraisal Lead",null],["24863","Govinda Raju M","Bengaluru","Senior Appraisal Partner",null],["25451","Metari Mahipal","Hyderabad","Appraisal Partner",null],["31621","Srinivasan G","Chennai","Appraisal Partner",null],["31619","Sathiya Raja G","Chennai","Appraisal Partner",null],["31840","Algar Harishwar Reddy","Hyderabad","Appraisal Partner",null],["32155","Kalyan Balu Khose","Pune","Senior Appraisal Partner",null],["37388","V Yugender","Hyderabad","Appraisal Partner",null],["37822","Rajanna Hanumala","Hyderabad","Appraisal Partner",null],["48888","Pravin Sampat Ugalmogale","Pune","Appraisal Trainee",null],["39156","Nilagiri Murthy","Hyderabad","Appraisal Partner",null],["41695","Shaik Gouse Mohiddin","Vijayawada","Appraisal Partner",null],["42335","Sandhigari Krishna Swamy","Hyderabad","Appraisal Partner",null],["42546","Hemalatha P","Chennai","Appraisal Partner",null],["43773","K Venkata Chary","Hyderabad","Appraisal Partner",null],["43506","Lingala Ganesh","Hyderabad","Appraisal Partner",null],["45202","Manjunatha P","Bengaluru","Appraisal Partner",null],["47662","Benjaram Bhasker reddy","Hyderabad","Appraisal Partner",null],["47545","Madu Nagaraju","Vijayawada","Appraisal Partner",null],["57109","Nepala Raju","Hyderabad","Appraisal Partner",null],["52712","Sunkari Kartheek","Hyderabad","Appraisal Partner",null],["57803","Korla Navakiran Reddy","Hyderabad","Appraisal Partner",null],["55450","Sudarshan K K","Bengaluru","Appraisal Trainee",null],["59917","Madaka Avinash","Hyderabad","Appraisal Trainee",null],["59112","Avala Laxmana Rao","Vijayawada","Appraisal Partner",null],["62634","Badikela Rajashekar","Hyderabad","Appraisal Partner",null],["59991","Vijay","Chennai","Appraisal Partner",null],["60800","Nandeesh J","Bengaluru","Appraisal Partner",null],["60794","Nagesh R","Bengaluru","Appraisal Partner",null],["60806","Anand B R","Bengaluru","Appraisal Partner",null],["61519","Yogananda G","Bengaluru","Appraisal Partner",null],["68975","Karim Rahim Khan","Pune","Appraisal Trainee",null],["62229","Baddam Jana Reddy","Hyderabad","Appraisal Partner",null],["66211","Mala Vannur Swamy","Bengaluru","Appraisal Trainee",null],["68479","Kusuma Revanth","Hyderabad","Appraisal Trainee",null],["68972","Karthik B V","Bengaluru","Appraisal Trainee",null],["69039","Yathish R","Bengaluru","Appraisal Partner",null],["73501","Muddsar Naim Shaikh","Pune","Appraisal Trainee",null],["80311","Gopi Vinoth","Chennai","Appraisal Partner",null],["70599","Vidiyala Venkatesh","Hyderabad","Appraisal Partner",null],["72797","Jagan","Chennai","Appraisal Trainee",null],["71495","Manepally Srikanth","Hyderabad","Appraisal Partner",null],["71463","Pradeep Kancharla","Warangal","Appraisal Partner",null],["71985","Madu Satyanarayana","Vijayawada","Appraisal Partner",null],["73950","Kandakatla Hareesh","Warangal","Appraisal Partner",null],["72762","Kavuluri Dorasani","Guntur","Appraisal Partner",null],["72995","Myakala Srinivas","Karimnagar","Appraisal Trainee",null],["72943","Velishoju Mahesh","Karimnagar","Appraisal Trainee",null],["72952","Shaik Sattar","Karimnagar","Appraisal Partner",null],["72949","Dadi Ilaiah","Karimnagar","Appraisal Partner",null],["73895","Mulukanuri Srikanth","Warangal","Appraisal Partner",null],["77528","Manohara M B","Bengaluru","Appraisal Trainee",null],["80345","Kamarajan K","Chennai","Senior Appraisal Partner",null],["76701","Ragam Abhishek","Karimnagar","Appraisal Partner",null],["76714","Gundoju Shiva","Karimnagar","Appraisal Partner",null],["77672","Syed Faisal","Hyderabad","Appraisal Trainee",null],["78761","T Goutham","Hyderabad","Appraisal Trainee",null],["75618","Pradeep Rao Daggu","Hyderabad","Appraisal Partner",null],["77670","Thigulla Sheshu Goud","Hyderabad","Appraisal Partner",null],["76996","Gugulothu Naresh","Hyderabad","Appraisal Partner",null],["76667","Gurram Chandra Shekar","Hyderabad","Appraisal Partner",null],["75811","Talla Venkataraju","Guntur","Appraisal Partner",null],["75806","Chinthala Sandeep","Karimnagar","Appraisal Partner",null],["77507","Naveen karkal","Bengaluru","Appraisal Trainee",null],["77908","Manjunath A","Bengaluru","Appraisal Trainee",null],["79715","Kanuma Naresh","Hyderabad","Appraisal Trainee",null],["77662","S Maruthi Kumar","Hyderabad","Appraisal Partner",null],["77522","Basavaraju M","Bengaluru","Senior Appraisal Partner",null],["80840","Sanket Ram Waghchoure","Pune","Appraisal Trainee",null],["79424","Lingampalli Ajay","Karimnagar","Appraisal Trainee","2026-01-02"],["79231","Durisheti Balachander","Karimnagar","Appraisal Trainee","2026-01-03"],["78980","Vengala Ravi Kumar","Warangal","Appraisal Partner","2026-01-05"],["81708","Shanthappa J Shivanagi","Bengaluru","Appraisal Partner","2026-01-09"],["84325","Gokulnath R","Chennai","Appraisal Trainee","2026-02-16"],["53222","Madipally Praveen","Hyderabad","Appraisal Partner",null],["68973","Dharvath Srinu","Hyderabad","Appraisal Partner",null],["73945","Devulapally Praveen","Warangal","Appraisal Trainee",null],["71652","Arunkumaran","Chennai","Appraisal Partner",null],["78398","Chandrashekar N","Bengaluru","Appraisal Partner",null],["72066","Arun B S","Bengaluru","Senior Appraisal Partner","2026-03-05"],["88730","Hemanth Kumar M K","Bengaluru","Appraisal Partner","2026-03-17"],["92393","M Narsing Rao","Hyderabad","Appraisal Partner","2026-05-18"],
];

const POINTS = {
  freshLoan: 30, takeover: 50, release: 20, privateSale: 20,
  goldSale: 30, raised: 30, leadGen: 10, selfSourceCxMet: 20,
};

const CUSTOMER_CANCEL_REASONS = ['Cancelled by Customer', 'customer_cancelled', 'Customer Cancelled'];

function sqlList(arr) { return arr.map(v => `'${v}'`).join(','); }

// Pan-India gazetted holidays that land on a working day (Mon-Sat) in Jan-Jul 2026 — used to bump the
// assumed 6/month baseline up if the real count for a given month is higher (never lower).
const GOVT_HOLIDAYS = ['2026-01-26', '2026-03-04', '2026-03-21', '2026-05-27'];

// Working days = calendar days minus Sundays minus holidays. Holidays are assumed at 6/month (prorated for
// a partial/MTD month) unless the actual count of known government holidays landing on a working day that
// month is higher, in which case the actual count is used instead.
function workingDaysInRange(year, month /* 1-12 */, throughDay) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = throughDay ? Math.min(throughDay, daysInMonth) : daysInMonth;
  let wd = 0;
  let realHolidaysCounted = 0;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  for (let d = 1; d <= lastDay; d++) {
    const dateKey = `${monthKey}-${String(d).padStart(2, '0')}`;
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); // 0 = Sunday
    if (dow === 0) continue; // Sunday, already excluded
    if (GOVT_HOLIDAYS.includes(dateKey)) { realHolidaysCounted++; continue; }
    wd++;
  }
  const assumedHolidays = Math.round(6 * (lastDay / daysInMonth));
  const extraAssumed = Math.max(0, assumedHolidays - realHolidaysCounted);
  return wd - extraAssumed;
}

async function main() {
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(nowUtc.getTime() + istOffsetMs);
  const todayStr = ist.toISOString().slice(0, 10);
  const currentMonthKey = todayStr.slice(0, 7);
  const todayDay = parseInt(todayStr.slice(8, 10), 10);

  const months = [];
  let y = 2026, m = 1;
  while (`${y}-${String(m).padStart(2, '0')}` <= currentMonthKey) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  const WD = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    WD[key] = key === currentMonthKey ? workingDaysInRange(yy, mm, todayDay) : workingDaysInRange(yy, mm, null);
  });

  const MONTH_ABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_LABEL = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    MONTH_LABEL[key] = `${MONTH_ABBR[mm]}-${String(yy).slice(2)}` + (key === currentMonthKey ? ' (MTD)' : '');
  });

  const agentIds = IDENTITY.map(([id]) => id);
  const agentInList = sqlList(agentIds);

  // agent|month -> { freshLoan, takeover, release, privateSale, raised, leadGen, selfSourceCxMet, goldSale } (counts, not points)
  const monthAgg = new Map();
  function addCount(agent, day, field, n = 1) {
    const month = day.slice(0, 7);
    if (!months.includes(month)) return;
    const key = `${agent}|${month}`;
    const cur = monthAgg.get(key) || { freshLoan: 0, takeover: 0, release: 0, privateSale: 0, goldSale: 0, raised: 0, leadGen: 0, selfSourceCxMet: 0 };
    cur[field] += n;
    monthAgg.set(key, cur);
  }

  console.log(`Fetching visits (Oro 2.0) for ${agentIds.length} APs, ${months[0]} through ${currentMonthKey}...`);
  // Release/Private sale are identified by visit_type='GR', NOT by visit_status='RELEASE_VISIT_COMPLETED'
  // or release_type (verified 2026-07-28 against the org-wide ~1,200-1,600 releases/month baseline):
  // release_type is populated on barely 2% of real completions, and RELEASE_VISIT_COMPLETED itself was
  // only adopted as a status in July 2026 — before that, releases carry ordinary VISIT_COMPLETED status.
  // visit_type='GR' is the only signal that holds across the whole date range.
  const visitQuery = `
    SELECT agent_auth_id, visit_time::date AS day, visit_status, loan_subtype, release_type, cancellation_reason, visit_type
    FROM visits
    WHERE agent_auth_id IN (${agentInList})
      AND visit_time >= '2026-01-01'
      AND (
        (visit_type='GR' AND visit_status IN ('VISIT_COMPLETED','RELEASE_VISIT_COMPLETED'))
        OR (visit_status='VISIT_COMPLETED' AND loan_subtype IN ('FRESH_LOAN','TAKEOVER'))
        OR (visit_status = 'VISIT_CANCELLED' AND cancellation_reason IN (${sqlList(CUSTOMER_CANCEL_REASONS)}))
      )
  `;
  const visitRows = await runQuery(ORO2_DB_ID, visitQuery);
  console.log(`  ${visitRows.length} visit rows`);

  visitRows.forEach(([agent, day, status, loanSubtype, releaseType, cancellationReason, visitType]) => {
    if (visitType === 'GR' && (status === 'VISIT_COMPLETED' || status === 'RELEASE_VISIT_COMPLETED')) {
      if (releaseType === 'PRIVATE_SALE' || releaseType === 'PART_PRIVATE_SALE') addCount(agent, day, 'privateSale');
      else addCount(agent, day, 'release');
    }
    else if (status === 'VISIT_COMPLETED' && loanSubtype === 'FRESH_LOAN') addCount(agent, day, 'freshLoan');
    else if (status === 'VISIT_COMPLETED' && loanSubtype === 'TAKEOVER') addCount(agent, day, 'takeover');
    else if (status === 'VISIT_CANCELLED') addCount(agent, day, 'raised');
  });

  console.log(`Fetching gbs_visits (Oro 2.0, Gold sale) for ${agentIds.length} APs...`);
  const gbsQuery = `
    SELECT agent_auth_id, visit_time::date AS day
    FROM gbs_visits
    WHERE agent_auth_id IN (${agentInList}) AND status = 'VISIT_COMPLETED' AND visit_time >= '2026-01-01'
  `;
  const gbsRows = await runQuery(ORO2_DB_ID, gbsQuery);
  console.log(`  ${gbsRows.length} gbs_visits rows`);
  gbsRows.forEach(([agent, day]) => addCount(agent, day, 'goldSale'));

  // Self-sourced = lead_source AND appointment_booked_by_id both match the AP (confirmed 2026-07-28 —
  // this is the definition behind the equivalent live Metabase card; created_by_oro_id alone is inflated
  // by a bulk/automated PX_APP channel and isn't a trustworthy self-sourcing signal on its own).
  console.log('Fetching AP emails (Oro 2.0 users) for the self-sourced lead match...');
  const emailRows = await runQuery(ORO2_DB_ID, `SELECT id, email_id FROM users WHERE id IN (${agentIds.join(',')})`);
  const emailByAgent = new Map(emailRows.map(([id, email]) => [String(id), email]));
  const apMapValues = agentIds
    .filter(id => emailByAgent.has(id))
    .map(id => `(${id},'${emailByAgent.get(id).replace(/'/g, "''")}')`)
    .join(',');

  console.log('Fetching self-sourced leads (Quali-prod) for lead-generation points...');
  const leadQuery = `
    WITH ap_map (agent_id, email) AS (VALUES ${apMapValues})
    SELECT m.agent_id, l.id AS lead_id, l.created_at::date AS day
    FROM lead l JOIN ap_map m ON lower(l.lead_source) = lower(m.email) AND l.appointment_booked_by_id = m.agent_id
    WHERE l.created_at >= '2026-01-01'
  `;
  const leadRows = await runQuery(QUALI_DB_ID, leadQuery);
  console.log(`  ${leadRows.length} self-sourced lead rows`);
  leadRows.forEach(([agent, , day]) => addCount(String(agent), day, 'leadGen'));

  console.log('Fetching self-sourced lead -> sales_visit links (Quali-prod) for self-source Cx Met...');
  const leadVisitLinkQuery = `
    WITH ap_map (agent_id, email) AS (VALUES ${apMapValues})
    SELECT m.agent_id, sv.id AS sales_visit_id
    FROM lead l JOIN ap_map m ON lower(l.lead_source) = lower(m.email) AND l.appointment_booked_by_id = m.agent_id
    JOIN sales_visit sv ON sv.lead_id = l.id
    WHERE l.created_at >= '2026-01-01'
  `;
  const leadVisitLinkRows = await runQuery(QUALI_DB_ID, leadVisitLinkQuery);
  console.log(`  ${leadVisitLinkRows.length} lead->sales_visit link rows`);
  if (leadVisitLinkRows.length > 0) {
    const agentBySalesVisitId = new Map(leadVisitLinkRows.map(([agent, svId]) => [svId, String(agent)]));
    const salesVisitIdList = [...agentBySalesVisitId.keys()].join(',');
    const completedVisitRows = await runQuery(ORO2_DB_ID, `
      SELECT sales_visit_id, visit_time::date AS day
      FROM visits
      WHERE sales_visit_id IN (${salesVisitIdList}) AND visit_status = 'VISIT_COMPLETED'
    `);
    console.log(`  ${completedVisitRows.length} of those reached VISIT_COMPLETED`);
    completedVisitRows.forEach(([svId, day]) => {
      const agent = agentBySalesVisitId.get(svId);
      if (agent) addCount(agent, day, 'selfSourceCxMet');
    });
  }

  const RAW = [];
  agentIds.forEach(agent => {
    months.forEach(month => {
      const a = monthAgg.get(`${agent}|${month}`);
      if (!a) return; // no activity at all this month — omit
      RAW.push([agent, month, a.freshLoan, a.takeover, a.release, a.privateSale, a.goldSale, a.raised, a.leadGen, a.selfSourceCxMet]);
    });
  });
  console.log(`Built ${RAW.length} agent-month rows.`);

  const monthCheckboxes = months.map(key => {
    const checked = key === currentMonthKey ? ' checked' : '';
    return `          <label><input type="checkbox" value="${key}"${checked}> ${MONTH_LABEL[key]}</label>`;
  }).join('\n');

  const refreshedAt = ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
  const statusLine = `Oro 2.0 visits/gbs_visits ⋈ Quali-prod lead/sales_visit (live) · ${IDENTITY.length} active APs, all cities`;

  let template = fs.readFileSync(path.join(__dirname, 'ap-rubric-template.html'), 'utf8');
  template = template
    .replace('__MONTH_CHECKBOXES__', monthCheckboxes)
    .replace('__STATUS_LINE__', statusLine)
    .replace('__RAW_DATA__', JSON.stringify(RAW))
    .replace('__IDENTITY_DATA__', JSON.stringify(IDENTITY))
    .replace('__WD_DATA__', JSON.stringify(WD))
    .replace('__MONTH_LABEL_DATA__', JSON.stringify(MONTH_LABEL))
    .replace('__REFRESHED_AT__', refreshedAt);

  fs.writeFileSync(path.join(__dirname, '..', 'ap_rubric_report.html'), template);
  console.log(`Wrote ap_rubric_report.html — ${RAW.length} rows, refreshed ${refreshedAt}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
