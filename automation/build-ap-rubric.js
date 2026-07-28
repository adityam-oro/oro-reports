// Weekly rebuild of the AP (Appraisal Partner) Rubric Report (runs alongside the SP rubric via GitHub
// Actions). Pulls fresh visit/loan/lead data live from Metabase and rewrites ap_rubric_report.html.
//
// Scoring model (locked in with the user, 2026-07-28): an AP's job is to earn 100 points/day through
// their activities. No daily cap (unlike SP's effort model) — if the numbers look off in practice we can
// add one later. Score = total points earned in the month ÷ (100 × working days in the month).
//   Fresh Loan completed      30 pts   visits.loan_subtype='FRESH_LOAN' AND visit_status='VISIT_COMPLETED'
//   Takeover completed        50 pts   visits.loan_subtype='TAKEOVER'   AND visit_status='VISIT_COMPLETED'
//   Release completed         20 pts   visits.visit_status='RELEASE_VISIT_COMPLETED' AND release_type IN (FULL_RELEASE, PART_RELEASE)
//   Private sale completed    20 pts   visits.visit_status='RELEASE_VISIT_COMPLETED' AND release_type IN (PRIVATE_SALE, PART_PRIVATE_SALE)
//   Gold sale (GBS) completed 30 pts   gbs_visits.status='VISIT_COMPLETED' (separate table/product, agent_auth_id)
//   Bridge loan (BRL) complete 25 pts  loans.loan_status='BRL_CLOSED' for a loan tied to one of the AP's completed
//                                       Takeover visits, dated by loan_history.brl_approved_at_timestamp (Oro's
//                                       systems don't record a distinct BRL-closure timestamp; a bridge loan only
//                                       lasts a few days by design, so the approval month is a close proxy for the
//                                       closure month) — SKIPPED if that date falls on the same calendar day as the
//                                       Takeover visit itself, so a single visit/transaction never earns points
//                                       twice (Takeover points supersede same-day Bridge Loan points).
//   Visit raised (no completion) 30 pts visits.visit_status='VISIT_CANCELLED' where the AP still did the work
//                                       (traveled, engaged the customer) but it didn't close — cancellation_reason
//                                       shows the customer backed out ("Cancelled by Customer" / "customer_cancelled"),
//                                       NOT system/auto-cancellations ("Auto-cancelled: ..."). A visit that reaches
//                                       VISIT_COMPLETED earns its completion-type points instead, never this bucket too.
//   Lead generation            10 pts  Quali-prod.lead where created_by_oro_id matches the AP's own agent id
//   Self-sourced Cx Met        20 pts  a lead the AP generated (created_by_oro_id = AP) whose linked sales_visit
//                                       (lead.id -> sales_visit.lead_id) maps to an Oro 2.0 visit
//                                       (sales_visit.id -> visits.sales_visit_id) that reached VISIT_COMPLETED
//
// Bands: <50% PIP (At risk) · 50-70% Needs improvement · 70-90% Good performance · >90% Star performer
//
// Roster: all active Appraisal Partners / Senior Appraisal Partners / Appraisal Leads / Appraisal Trainees
// across every city (no city exclusion for AP, unlike the SP rubric's Chennai exclusion) — 91 of the 135
// active people on the 2026-07-28 HR sheet, resolved to their agent_auth_id via the `users` table (Oro 2.0).
// 44 could not be resolved (mostly 2025/2026 joiners not yet tagged with an appraisal role in that table, or
// people promoted to a managerial role) — hardcoded below, update by hand as more get resolved.
// Cx escalations and recovery-case handling are NOT yet scored — noted in the report as a future addition.
//
// Required environment variables (same GitHub Actions secrets as the SP rubric):
//   METABASE_URL, METABASE_API_KEY, QUALI_DB_ID (Quali-prod: lead/sales_visit/loan_history),
//   ORO2_DB_ID (Oro 2.0: visits/gbs_visits/loans)

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

// [agent_auth_id, name, city, designation] — resolved from the 2026-07-28 HR sheet by matching name
// (and, where needed, city) against Oro 2.0's `users` table. 91 of 135 active APs resolved; the other 44
// (mostly 2025/2026 joiners or people promoted to management) aren't tagged with an appraisal role in
// `users` yet — add them by hand once resolved (see chat history 2026-07-28 for the unresolved-name list).
const IDENTITY = [
["265","Manikandan R","Chennai","Senior Appraisal Partner"],["289","Shankar S","Chennai","Senior Appraisal Partner"],["678","Ramesh AS","Chennai","Senior Appraisal Partner"],["1718","Tamilazhagan R","Chennai","Senior Appraisal Partner"],["1572","Lakshmana G","Bengaluru","Appraisal Partner"],["2169","Praveen Kumar M","Bengaluru","Senior Appraisal Partner"],["2308","Sachin Danai","Pune","Appraisal Partner"],["4380","Santhosha K","Bengaluru","Senior Appraisal Partner"],["5828","Jagadeesha C","Bengaluru","Appraisal Partner"],["7286","Kaustubh K Kulkarni","Pune","Appraisal Lead"],["24863","Govinda Raju M","Bengaluru","Senior Appraisal Partner"],["25451","Metari Mahipal","Hyderabad","Appraisal Partner"],["31621","Srinivasan G","Chennai","Appraisal Partner"],["31619","Sathiya Raja G","Chennai","Appraisal Partner"],["31840","Algar Harishwar Reddy","Hyderabad","Appraisal Partner"],["32155","Kalyan Balu Khose","Pune","Senior Appraisal Partner"],["37388","V Yugender","Hyderabad","Appraisal Partner"],["37822","Rajanna Hanumala","Hyderabad","Appraisal Partner"],["48888","Pravin Sampat Ugalmogale","Pune","Appraisal Trainee"],["39156","Nilagiri Murthy","Hyderabad","Appraisal Partner"],["41695","Shaik Gouse Mohiddin","Vijayawada","Appraisal Partner"],["42335","Sandhigari Krishna Swamy","Hyderabad","Appraisal Partner"],["42546","Hemalatha P","Chennai","Appraisal Partner"],["43773","K Venkata Chary","Hyderabad","Appraisal Partner"],["43506","Lingala Ganesh","Hyderabad","Appraisal Partner"],["45202","Manjunatha P","Bengaluru","Appraisal Partner"],["47662","Benjaram Bhasker reddy","Hyderabad","Appraisal Partner"],["47545","Madu Nagaraju","Vijayawada","Appraisal Partner"],["57109","Nepala Raju","Hyderabad","Appraisal Partner"],["52712","Sunkari Kartheek","Hyderabad","Appraisal Partner"],["57803","Korla Navakiran Reddy","Hyderabad","Appraisal Partner"],["55450","Sudarshan K K","Bengaluru","Appraisal Trainee"],["59917","Madaka Avinash","Hyderabad","Appraisal Trainee"],["59112","Avala Laxmana Rao","Vijayawada","Appraisal Partner"],["62634","Badikela Rajashekar","Hyderabad","Appraisal Partner"],["59991","Vijay","Chennai","Appraisal Partner"],["60800","Nandeesh J","Bengaluru","Appraisal Partner"],["60794","Nagesh R","Bengaluru","Appraisal Partner"],["60806","Anand B R","Bengaluru","Appraisal Partner"],["61519","Yogananda G","Bengaluru","Appraisal Partner"],["68975","Karim Rahim Khan","Pune","Appraisal Trainee"],["62229","Baddam Jana Reddy","Hyderabad","Appraisal Partner"],["66211","Mala Vannur Swamy","Bengaluru","Appraisal Trainee"],["68479","Kusuma Revanth","Hyderabad","Appraisal Trainee"],["68972","Karthik B V","Bengaluru","Appraisal Trainee"],["69039","Yathish R","Bengaluru","Appraisal Partner"],["73501","Muddsar Naim Shaikh","Pune","Appraisal Trainee"],["80311","Gopi Vinoth","Chennai","Appraisal Partner"],["70599","Vidiyala Venkatesh","Hyderabad","Appraisal Partner"],["72797","Jagan","Chennai","Appraisal Trainee"],["71495","Manepally Srikanth","Hyderabad","Appraisal Partner"],["71463","Pradeep Kancharla","Warangal","Appraisal Partner"],["71985","Madu Satyanarayana","Vijayawada","Appraisal Partner"],["73950","Kandakatla Hareesh","Warangal","Appraisal Partner"],["72762","Kavuluri Dorasani","Guntur","Appraisal Partner"],["72995","Myakala Srinivas","Karimnagar","Appraisal Trainee"],["72943","Velishoju Mahesh","Karimnagar","Appraisal Trainee"],["72952","Shaik Sattar","Karimnagar","Appraisal Partner"],["72949","Dadi Ilaiah","Karimnagar","Appraisal Partner"],["73895","Mulukanuri Srikanth","Warangal","Appraisal Partner"],["77528","Manohara M B","Bengaluru","Appraisal Trainee"],["80345","Kamarajan K","Chennai","Senior Appraisal Partner"],["76701","Ragam Abhishek","Karimnagar","Appraisal Partner"],["76714","Gundoju Shiva","Karimnagar","Appraisal Partner"],["77672","Syed Faisal","Hyderabad","Appraisal Trainee"],["78761","T Goutham","Hyderabad","Appraisal Trainee"],["75618","Pradeep Rao Daggu","Hyderabad","Appraisal Partner"],["77670","Thigulla Sheshu Goud","Hyderabad","Appraisal Partner"],["76996","Gugulothu Naresh","Hyderabad","Appraisal Partner"],["76667","Gurram Chandra Shekar","Hyderabad","Appraisal Partner"],["75811","Talla Venkataraju","Guntur","Appraisal Partner"],["75806","Chinthala Sandeep","Karimnagar","Appraisal Partner"],["77507","Naveen karkal","Bengaluru","Appraisal Trainee"],["77908","Manjunath A","Bengaluru","Appraisal Trainee"],["79715","Kanuma Naresh","Hyderabad","Appraisal Trainee"],["77662","S Maruthi Kumar","Hyderabad","Appraisal Partner"],["77522","Basavaraju M","Bengaluru","Senior Appraisal Partner"],["80840","Sanket Ram Waghchoure","Pune","Appraisal Trainee"],["79424","Lingampalli Ajay","Karimnagar","Appraisal Trainee"],["79231","Durisheti Balachander","Karimnagar","Appraisal Trainee"],["78980","Vengala Ravi Kumar","Warangal","Appraisal Partner"],["81708","Shanthappa J Shivanagi","Bengaluru","Appraisal Partner"],["84325","Gokulnath R","Chennai","Appraisal Trainee"],["53222","Madipally Praveen","Hyderabad","Appraisal Partner"],["68973","Dharvath Srinu","Hyderabad","Appraisal Partner"],["73945","Devulapally Praveen","Warangal","Appraisal Trainee"],["71652","Arunkumaran","Chennai","Appraisal Partner"],["78398","Chandrashekar N","Bengaluru","Appraisal Partner"],["72066","Arun B S","Bengaluru","Senior Appraisal Partner"],["88730","Hemanth Kumar M K","Bengaluru","Appraisal Partner"],["92393","M Narsing Rao","Hyderabad","Appraisal Partner"],
];

const POINTS = {
  freshLoan: 30, takeover: 50, release: 20, privateSale: 20,
  goldSale: 30, bridgeLoan: 25, raised: 30, leadGen: 10, selfSourceCxMet: 20,
};

const CUSTOMER_CANCEL_REASONS = ['Cancelled by Customer', 'customer_cancelled', 'Customer Cancelled'];

function sqlList(arr) { return arr.map(v => `'${v}'`).join(','); }

// Working days = calendar days minus Sundays. For the current (in-progress) month, only count days
// up to and including "today" (IST) — same convention as the SP rubric.
function workingDaysInRange(year, month /* 1-12 */, throughDay) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = throughDay ? Math.min(throughDay, daysInMonth) : daysInMonth;
  let wd = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); // 0 = Sunday
    if (dow !== 0) wd++;
  }
  return wd;
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

  // agent|month -> { freshLoan, takeover, release, privateSale, raised, leadGen, selfSourceCxMet, bridgeLoan, goldSale } (counts, not points)
  const monthAgg = new Map();
  function addCount(agent, day, field, n = 1) {
    const month = day.slice(0, 7);
    if (!months.includes(month)) return;
    const key = `${agent}|${month}`;
    const cur = monthAgg.get(key) || { freshLoan: 0, takeover: 0, release: 0, privateSale: 0, goldSale: 0, bridgeLoan: 0, raised: 0, leadGen: 0, selfSourceCxMet: 0 };
    cur[field] += n;
    monthAgg.set(key, cur);
  }

  console.log(`Fetching visits (Oro 2.0) for ${agentIds.length} APs, ${months[0]} through ${currentMonthKey}...`);
  const visitQuery = `
    SELECT agent_auth_id, visit_time::date AS day, visit_status, loan_subtype, release_type, cancellation_reason, loan_id
    FROM visits
    WHERE agent_auth_id IN (${agentInList})
      AND visit_time >= '2026-01-01'
      AND (visit_status IN ('VISIT_COMPLETED','RELEASE_VISIT_COMPLETED')
           OR (visit_status = 'VISIT_CANCELLED' AND cancellation_reason IN (${sqlList(CUSTOMER_CANCEL_REASONS)})))
  `;
  const visitRows = await runQuery(ORO2_DB_ID, visitQuery);
  console.log(`  ${visitRows.length} visit rows`);

  const takeoverLoanIds = new Set(); // loan_id -> collect for BRL lookup, tagged with agent+day
  const takeoverByLoanId = new Map(); // loan_id -> {agent, day}

  visitRows.forEach(([agent, day, status, loanSubtype, releaseType, cancellationReason, loanId]) => {
    if (status === 'VISIT_COMPLETED' && loanSubtype === 'FRESH_LOAN') addCount(agent, day, 'freshLoan');
    else if (status === 'VISIT_COMPLETED' && loanSubtype === 'TAKEOVER') {
      addCount(agent, day, 'takeover');
      if (loanId != null) { takeoverLoanIds.add(loanId); takeoverByLoanId.set(loanId, { agent, day }); }
    }
    else if (status === 'RELEASE_VISIT_COMPLETED' && (releaseType === 'FULL_RELEASE' || releaseType === 'PART_RELEASE')) addCount(agent, day, 'release');
    else if (status === 'RELEASE_VISIT_COMPLETED' && (releaseType === 'PRIVATE_SALE' || releaseType === 'PART_PRIVATE_SALE')) addCount(agent, day, 'privateSale');
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

  console.log(`Fetching BRL_CLOSED loans (Oro 2.0) tied to ${takeoverLoanIds.size} Takeover-completed loans...`);
  let bridgeLoanCount = 0;
  if (takeoverLoanIds.size > 0) {
    const loanIdList = [...takeoverLoanIds].join(',');
    const brlClosedRows = await runQuery(ORO2_DB_ID, `SELECT id FROM loans WHERE id IN (${loanIdList}) AND loan_status = 'BRL_CLOSED'`);
    const brlClosedLoanIds = brlClosedRows.map(([id]) => id);
    console.log(`  ${brlClosedLoanIds.length} loans reached BRL_CLOSED`);

    if (brlClosedLoanIds.length > 0) {
      console.log('Fetching brl_approved_at_timestamp (Quali-prod loan_history) for dating...');
      const historyRows = await runQuery(QUALI_DB_ID, `
        SELECT loan_id, brl_approved_at_timestamp::date AS day
        FROM loan_history
        WHERE loan_id IN (${brlClosedLoanIds.join(',')}) AND brl_approved_at_timestamp IS NOT NULL
      `);
      const brlDateByLoanId = new Map();
      historyRows.forEach(([loanId, day]) => { if (!brlDateByLoanId.has(loanId)) brlDateByLoanId.set(loanId, day); });

      brlClosedLoanIds.forEach(loanId => {
        const brlDay = brlDateByLoanId.get(loanId);
        const takeover = takeoverByLoanId.get(loanId);
        if (!brlDay || !takeover) return; // no date to attribute to, or loan_id somehow not in our lookup
        if (brlDay === takeover.day) return; // same-day as the Takeover visit — Takeover points supersede, no double-count
        addCount(takeover.agent, brlDay, 'bridgeLoan');
        bridgeLoanCount++;
      });
    }
  }
  console.log(`  ${bridgeLoanCount} Bridge Loan Complete events (after same-day-as-Takeover dedup)`);

  console.log('Fetching self-sourced leads (Quali-prod) for lead-generation points...');
  const leadQuery = `
    SELECT created_by_oro_id, created_at::date AS day
    FROM lead
    WHERE created_by_oro_id IN (${agentInList}) AND created_at >= '2026-01-01'
  `;
  const leadRows = await runQuery(QUALI_DB_ID, leadQuery);
  console.log(`  ${leadRows.length} self-sourced lead rows`);
  leadRows.forEach(([agent, day]) => addCount(agent, day, 'leadGen'));

  console.log('Fetching self-sourced lead -> sales_visit links (Quali-prod) for self-source Cx Met...');
  const leadVisitLinkRows = await runQuery(QUALI_DB_ID, `
    SELECT l.created_by_oro_id, sv.id AS sales_visit_id
    FROM lead l JOIN sales_visit sv ON sv.lead_id = l.id
    WHERE l.created_by_oro_id IN (${agentInList}) AND l.created_at >= '2026-01-01'
  `);
  console.log(`  ${leadVisitLinkRows.length} lead->sales_visit link rows`);
  if (leadVisitLinkRows.length > 0) {
    const agentBySalesVisitId = new Map(leadVisitLinkRows.map(([agent, svId]) => [svId, agent]));
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
      RAW.push([agent, month, a.freshLoan, a.takeover, a.release, a.privateSale, a.goldSale, a.bridgeLoan, a.raised, a.leadGen, a.selfSourceCxMet]);
    });
  });
  console.log(`Built ${RAW.length} agent-month rows.`);

  const monthCheckboxes = months.map(key => {
    const checked = key === currentMonthKey ? ' checked' : '';
    return `          <label><input type="checkbox" value="${key}"${checked}> ${MONTH_LABEL[key]}</label>`;
  }).join('\n');

  const refreshedAt = ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
  const statusLine = `Oro 2.0 visits/gbs_visits/loans ⋈ Quali-prod lead/sales_visit/loan_history (live) · ${IDENTITY.length} active APs, all cities`;

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
