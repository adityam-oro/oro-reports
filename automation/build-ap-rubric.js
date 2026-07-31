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
//   Release completed         20 pts   visits.visit_type='GR' AND visit_status IN ('VISIT_COMPLETED','RELEASE_VISIT_COMPLETED'), release_type not IN (PRIVATE_SALE, PART_PRIVATE_SALE) — see the query below for why visit_type='GR' (not release_type/RELEASE_VISIT_COMPLETED alone) is the detection signal
//   Private sale completed    20 pts   same as above, with release_type IN (PRIVATE_SALE, PART_PRIVATE_SALE)
//   Gold sale (GBS) completed 30 pts   gbs_visits.status='VISIT_COMPLETED' (separate table/product, agent_auth_id)
//   Visit raised (no completion) 15 pts visits.visit_status='VISIT_CANCELLED' where the AP still did the work
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
// Bands: <60% At risk · 60-75% Needs improvement · 75-95% Good performance · >95% Star performer.
// New-joiner exception: an AP who is At risk and still within their first 3 months of joining (by DOJ) is
// held out of every table/stat in the report entirely, not just re-labeled.
//
// Roster: all active Appraisal Partners / Senior Appraisal Partners / Appraisal Leads / Appraisal Trainees
// across every city (no city exclusion for AP, unlike the SP rubric's Chennai exclusion) — 125 of the 135
// active people on the 2026-07-28 HR sheet (ROSTER_TOTAL below), resolved to their agent_auth_id via the
// `users` table (Oro 2.0). The rest could not be resolved (mostly 2025/2026 joiners not yet tagged with an
// appraisal role in that table, or people promoted to a managerial role) — hardcoded below, update by hand
// as more get resolved, and update ROSTER_TOTAL whenever a fresh HR export changes the active headcount.
// Added 2026-07-31: Sandeep Fulchand Lokhande (id 82227) — Oro 2.0's role_name/HR "Office Staff" tag was
// stale (his role recently changed to AP per the user); confirmed via 236 real GR/release visits Feb-Jul 2026.
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
// (and, where needed, city) against Oro 2.0's `users` table. 124 of 135 active APs resolved; the rest
// (mostly 2025/2026 joiners or people promoted to management) aren't tagged with an appraisal role in
// `users` yet — add them by hand once resolved (see chat history 2026-07-28 for the unresolved-name list).
// doj is null for anyone who joined more than a year ago (irrelevant to the 3-month new-joiner rule) —
// only 2026 joiners need the exact date on file.
const IDENTITY = [
["265","MANIKANDAN R","Chennai","Senior Appraisal Partner","2021-03-17"],["678","Ramesh AS","Chennai","Senior Appraisal Partner","2021-06-28"],["1441","Bathini Rama mohan Reddy","Bengaluru","Senior Appraisal Partner","2021-12-21"],["1718","Tamilazhagan R","Chennai","Senior Appraisal Partner","2022-01-03"],["1572","Lakshmana","Bengaluru","Appraisal Partner","2022-01-10"],["2169","Praveen Kumar M","Bengaluru","Senior Appraisal Partner","2022-03-01"],["2308","Sachin Danai","Pune","Appraisal Partner","2022-03-04"],["4380","SANTHOSHA K","Bengaluru","Senior Appraisal Partner","2022-06-17"],["24863","Govinda Raju m","Bengaluru","Senior Appraisal Partner","2023-04-01"],["25451","Metari mahipal","Hyderabad","Appraisal Partner","2023-04-18"],["31621","G Srinivasan","Chennai","Appraisal Partner","2023-10-04"],["31619","Sathiya Raja G","Chennai","Appraisal Partner","2023-10-04"],["31840","Algar Harishwar Reddy","Hyderabad","Appraisal Partner","2023-11-08"],["32155","Kalyan Khose","Pune","Senior Appraisal Partner","2023-12-04"],["37388","V Yugender","Hyderabad","Appraisal Partner","2024-04-29"],["48888","Pravin Sampat Ugalmogale","Pune","Appraisal Trainee","2024-05-20"],["39156","Nilagiri Murthy","Hyderabad","Appraisal Partner","2024-06-01"],["41695","Shaik Gouse Mohiddin","Vijayawada","Appraisal Partner","2024-07-02"],["42335","Sandhigari Krishna Swamy","Hyderabad","Appraisal Partner","2024-08-01"],["42546","Hemalatha P","Chennai","Appraisal Partner","2024-08-05"],["84335","Hariprasad K","Hyderabad","Appraisal Partner","2024-08-21"],["43773","K Venkata Chary","Hyderabad","Appraisal Partner","2024-09-02"],["43506","Lingala Ganesh","Hyderabad","Appraisal Partner","2024-09-09"],["45202","Manjunatha P","Bengaluru","Appraisal Partner","2024-11-07"],["47662","Benjaram Bhasker Reddy","Hyderabad","Appraisal Partner","2024-12-03"],["47545","Madu Nagaraju","Vijayawada","Appraisal Partner","2024-12-23"],["53222","Madipalli Praveen","Hyderabad","Appraisal Partner","2025-02-01"],["57109","Nepala Raju","Hyderabad","Appraisal Partner","2025-02-13"],["52712","Sunkari Kartheek","Hyderabad","Appraisal Partner","2025-02-17"],["57803","Korla Navakiran Reddy","Hyderabad","Appraisal Partner","2025-03-10"],["55450","Sudarshan K K","Bengaluru","Appraisal Trainee","2025-03-17"],["59917","Madaka Avinash","Hyderabad","Appraisal Trainee","2025-03-19"],["84337","Laxmanarao A","Vijayawada","Appraisal Partner","2025-04-23"],["62634","Badikela Rajashekar","Hyderabad","Appraisal Partner","2025-05-02"],["59991","Vijay A","Chennai","Appraisal Partner","2025-05-02"],["60800","Nandeesh J","Bengaluru","Appraisal Partner","2025-05-02"],["60794","Nagesh R","Bengaluru","Appraisal Partner","2025-05-02"],["60806","Anand B R","Bengaluru","Appraisal Partner","2025-05-12"],["61519","Yogananda G","Bengaluru","Appraisal Partner","2025-05-12"],["68975","Karim Rahim Khan","Pune","Appraisal Trainee","2025-06-02"],["62229","Baddam Jana Reddy","Hyderabad","Appraisal Partner","2025-06-05"],["66211","Mala Vannur Swamy","Bengaluru","Appraisal Trainee","2025-06-24"],["65822","Ramkumar Ramadass","Bengaluru","Appraisal Trainee","2025-07-01"],["68479","Kusuma Revanth","Hyderabad","Appraisal Trainee","2025-07-16"],["68973","DHARAVATH SRINU","Hyderabad","Appraisal Partner","2025-07-16"],["68972","Karthik B V","Bengaluru","Appraisal Trainee","2025-08-06"],["69039","Yathish R","Bengaluru","Appraisal Partner","2025-08-11"],["73501","Muddsar Naim Shaikh","Pune","Appraisal Trainee","2025-08-13"],["80311","Gopi Vinoth","Chennai","Appraisal Partner","2025-08-22"],["70599","Vidiyala Venkatesh","Hyderabad","Appraisal Partner","2025-09-08"],["72797","Jagan H","Chennai","Appraisal Trainee","2025-09-18"],["71495","Manepally Srikanth","Hyderabad","Appraisal Partner","2025-09-25"],["71463","Pradeep Kancharla","Warangal","Appraisal Partner","2025-09-26"],["71985","Madu Satyanarayana","Vijayawada","Appraisal Partner","2025-09-29"],["73950","Kandakatla Hareesh","Warangal","Appraisal Partner","2025-10-06"],["73945","Devualapally Praveen","Warangal","Appraisal Trainee","2025-10-06"],["71652","Arun Kumaran S","Chennai","Appraisal Partner","2025-10-07"],["72762","Kavuluri Dorasani","Guntur","Appraisal Partner","2025-10-13"],["72995","Myakala Srinivas","Karimnagar","Appraisal Trainee","2025-10-21"],["72943","Velishoju Mahesh","Karimnagar","Appraisal Trainee","2025-10-21"],["72952","Shaik Sattar","Karimnagar","Appraisal Partner","2025-10-21"],["72949","Dadi Ilaiah","Karimnagar","Appraisal Partner","2025-10-24"],["84323","Srikanth M","Warangal","Appraisal Partner","2025-11-03"],["77528","Manohara M B","Bengaluru","Appraisal Trainee","2025-11-11"],["80345","Kamarajan K","Chennai","Senior Appraisal Partner","2025-11-15"],["76701","Ragam Abhishek","Karimnagar","Appraisal Partner","2025-11-17"],["76714","Gundoju Shiva","Karimnagar","Appraisal Partner","2025-11-17"],["77672","Syed Faisal","Hyderabad","Appraisal Trainee","2025-11-17"],["78761","T Goutham","Hyderabad","Appraisal Trainee","2025-11-17"],["75618","Pradeep Rao Daggu","Hyderabad","Appraisal Partner","2025-11-17"],["77670","Thigulla Sheshu Goud","Hyderabad","Appraisal Partner","2025-11-17"],["76552","Pagidimarri Y Chary","Hyderabad","Appraisal Partner","2025-11-17"],["76667","Gurram Chandra Shekar","Hyderabad","Appraisal Partner","2025-11-17"],["75811","Talla Venkataraju","Guntur","Appraisal Partner","2025-11-24"],["84339","Sandeep C","Karimnagar","Appraisal Partner","2025-11-27"],["77507","Naveen Karkal","Bengaluru","Appraisal Trainee","2025-12-01"],["77908","Manjunath A","Bengaluru","Appraisal Trainee","2025-12-01"],["79715","Kanuma Naresh","Hyderabad","Appraisal Trainee","2025-12-03"],["77662","S Maruthi Kumar","Hyderabad","Appraisal Partner","2025-12-05"],["77522","Basavaraju M","Bengaluru","Senior Appraisal Partner","2025-12-08"],["80840","Sanket Ram Waghchoure","Pune","Appraisal Trainee","2025-12-15"],["78398","Chandra Shekar N","Bengaluru","Appraisal Partner","2025-12-22"],["79424","Lingampalli Ajay","Karimnagar","Appraisal Trainee","2026-01-02"],["79231","Durisheti Balachander","Karimnagar","Appraisal Trainee","2026-01-03"],["78980","Vengala Ravi Kumar","Warangal","Appraisal Partner","2026-01-05"],["81708","Shanthappa J Shivanagi","Bengaluru","Appraisal Partner","2026-01-09"],["84327","Pratik VS","Pune","Appraisal Trainee","2026-01-16"],["84336","Dillibabu M","Chennai","Appraisal Trainee","2026-01-22"],["86352","Pavanprasad B","Vijayawada","Appraisal Trainee","2026-02-05"],["87528","Shivaprasad K","Pune","Appraisal Trainee","2026-02-11"],["85106","Gangunaidu K","Hyderabad","Appraisal Partner","2026-02-12"],["84324","Deva D","Chennai","Appraisal Trainee","2026-02-16"],["84325","Gokulnath R","Chennai","Appraisal Trainee","2026-02-16"],["86225","Renuka K","Hyderabad","Appraisal Partner","2026-02-20"],["87530","Pallavi RK","Pune","Appraisal Partner","2026-02-26"],["88729","Arun BS","Bengaluru","Senior Appraisal Partner","2026-03-05"],["88292","Paramesh C","Hyderabad","Appraisal Partner","2026-03-05"],["86494","Aniket B","Pune","Appraisal Trainee","2026-03-06"],["88730","Hemanthkumar MK","Bengaluru","Appraisal Partner","2026-03-17"],["89697","Vamsimohan K","Vijayawada","Appraisal Trainee","2026-03-23"],["89872","Narendrakumar B","Vijayawada","Appraisal Trainee","2026-03-23"],["89696","Kumarreddy R","Vijayawada","Appraisal Trainee","2026-04-01"],["93451","Chandu V","Vijayawada","Appraisal Trainee","2026-04-02"],["90718","Vinaykumar T","Hyderabad","Appraisal Trainee","2026-04-06"],["93452","Rakshanaanandraju D","Vijayawada","Appraisal Trainee","2026-04-06"],["90725","Yathin M","Hyderabad","Appraisal Trainee","2026-04-06"],["90740","Suresh G","Bengaluru","Appraisal Trainee","2026-04-06"],["91800","Runay S","Hyderabad","Appraisal Trainee","2026-04-08"],["91801","Balasatish L","Hyderabad","Appraisal Partner","2026-04-13"],["93454","Sasidhar G","Vijayawada","Appraisal Trainee","2026-04-16"],["93446","Udaybhanu J","Vijayawada","Appraisal Trainee","2026-04-16"],["91802","Praneeth Kumar","Hyderabad","Appraisal Trainee","2026-04-17"],["89738","Nagarjuna KV","Guntur","Appraisal Trainee","2026-04-20"],["93267","Sachin DE","Warangal","Appraisal Trainee","2026-05-11"],["92786","Musthafa V","Hyderabad","Appraisal Trainee","2026-05-11"],["92785","Shamkumar S","Chennai","Senior Appraisal Partner","2026-05-12"],["92393","Narsingrao M","Hyderabad","Appraisal Partner","2026-05-18"],["93901","Sairajesh SH","Pune","Appraisal Partner","2026-05-19"],["95406","Durgaprasad KV","Guntur","Appraisal Partner","2026-06-10"],["94706","Vivek M","Warangal","Appraisal Trainee","2026-06-16"],["94705","Madhukar D","Warangal","Appraisal Trainee","2026-06-16"],["94704","Bhanuprakash M","Warangal","Appraisal Trainee","2026-06-16"],["95962","Vijaykanth RR","Guntur","Appraisal Trainee","2026-06-17"],["95411","Shaik A","Vijayawada","Appraisal Partner","2026-07-01"],["82227","Sandeep Fulchand Lokhande","Pune","Appraisal Partner","2024-06-01"],
];

// Total active APs on the latest HR export (135 as of 2026-07-28) — update by hand whenever the roster is
// re-pulled. IDENTITY.length is the resolved subset of this total; the footer reports both.
const ROSTER_TOTAL = 135;

const POINTS = {
  freshLoan: 30, takeover: 50, release: 20, privateSale: 20,
  goldSale: 30, raised: 15, leadGen: 10, selfSourceCxMet: 20,
};

// Fixed 2026-07-31: cancellation_reason (the old signal) was scoring ~0 for every AP for Jan-Jun because
// the org simply didn't populate 'Cancelled by Customer'/'customer_cancelled' text values until July 2026
// (same adoption-lag pattern as RELEASE_VISIT_COMPLETED) — cancellation_reason_id is also basically unused
// (9 of 31,356 cancelled visits org-wide). Verified proxy instead: cancelled_by_auth_id = customer_auth_id
// resolves to a `users.role_name = 'CUSTOMER'` account 100% of the time (2,479/2,479 checked against Oro
// 2.0 users, Jan-Jun 2026), and the non-customer cancellers cluster on a handful of repeated internal
// auth_ids (ops/support staff), not noise — so this is a safe, non-conflating signal for "customer backed
// out", independent of whatever string ends up in cancellation_reason.

// visits/gbs_visits.agent_auth_id stores users.auth_id, which for most APs is just their numeric
// users.id as a string — but for these 3 (older/senior accounts) it's a genuine Firebase UID.
// Querying by numeric id for them silently returned zero rows (verified 2026-07-28). All other
// 88 of 91 resolved APs have auth_id === id and need no override.
const AUTH_ID_OVERRIDE = {
  '265': 'sAR94WWuviVxZNNKFkRfyNvshlk2', // Manikandan R
  '289': 'kYNsJEcRT7h98wgdbBsV6jTvq4B3', // Shankar S
  '678': '49baab98-870e-4233-bcf0-f09e777748de', // Ramesh AS
};

function sqlList(arr) { return arr.map(v => `'${v}'`).join(','); }

// 2026 state-wise bank holiday calendars (source: Federal Bank's 2026 holiday list, supplied 2026-07-31),
// restricted to the 5 states the AP roster's cities fall in. These are on top of the Sunday/2nd-4th-Saturday
// rule below — a holiday landing on a day already off (Sunday, or a 2nd/4th Saturday) doesn't double-subtract.
const ANDHRA_PRADESH_HOLIDAYS = ['2026-01-15','2026-01-26','2026-02-15','2026-03-03','2026-03-19','2026-03-20','2026-03-27','2026-04-01','2026-04-03','2026-04-14','2026-05-01','2026-05-27','2026-06-25','2026-08-15','2026-08-25','2026-09-04','2026-09-14','2026-10-02','2026-10-20','2026-11-08','2026-12-25'];
const TELANGANA_HOLIDAYS = ['2026-01-15','2026-01-26','2026-02-15','2026-03-03','2026-03-19','2026-03-21','2026-03-27','2026-04-01','2026-04-03','2026-04-05','2026-04-14','2026-05-01','2026-05-27','2026-06-26','2026-08-15','2026-08-26','2026-09-04','2026-09-14','2026-10-02','2026-10-20','2026-11-08','2026-11-24','2026-12-25'];
const KARNATAKA_HOLIDAYS = ['2026-01-15','2026-01-26','2026-02-15','2026-03-19','2026-03-21','2026-03-31','2026-04-03','2026-04-14','2026-04-20','2026-05-01','2026-05-28','2026-06-26','2026-08-15','2026-08-26','2026-09-14','2026-10-02','2026-10-10','2026-10-20','2026-10-21','2026-10-25','2026-11-01','2026-11-08','2026-11-10','2026-11-27','2026-12-25'];
const TAMIL_NADU_HOLIDAYS = ['2026-01-01','2026-01-15','2026-01-16','2026-01-17','2026-01-26','2026-02-01','2026-03-19','2026-03-21','2026-03-31','2026-04-01','2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26','2026-08-15','2026-08-26','2026-09-04','2026-09-14','2026-10-02','2026-10-19','2026-10-20','2026-11-08','2026-12-25'];
const MAHARASHTRA_HOLIDAYS = ['2026-01-26','2026-02-15','2026-02-19','2026-03-03','2026-03-19','2026-03-21','2026-03-26','2026-03-31','2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26','2026-08-15','2026-08-26','2026-09-14','2026-10-02','2026-10-20','2026-11-08','2026-11-10','2026-11-24','2026-12-25'];

// Every city in the AP roster, mapped to its state's holiday calendar above.
const CITY_HOLIDAYS = {
  Chennai: TAMIL_NADU_HOLIDAYS,
  Bengaluru: KARNATAKA_HOLIDAYS,
  Hyderabad: TELANGANA_HOLIDAYS,
  Warangal: TELANGANA_HOLIDAYS,
  Karimnagar: TELANGANA_HOLIDAYS,
  Vijayawada: ANDHRA_PRADESH_HOLIDAYS,
  Guntur: ANDHRA_PRADESH_HOLIDAYS,
  Pune: MAHARASHTRA_HOLIDAYS,
};

// Working days = calendar days minus Sundays minus the 2nd and 4th Saturday of the month (Oro's actual
// off-day policy) minus that city's state bank holidays falling on a day that would otherwise be a working
// day. Fixed 2026-07-31: the old formula subtracted Sundays, then subtracted a further ~6/month "assumed
// holiday" allowance on top — since Sundays were already gone, that allowance was really re-subtracting them
// a second time (4 Sundays + ~2 more) and over-cut every month by ~4 days (Jan read 21, should be 25).
function workingDaysInRange(year, month /* 1-12 */, throughDay, holidayList) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = throughDay ? Math.min(throughDay, daysInMonth) : daysInMonth;
  const saturdaysInMonth = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 6) saturdaysInMonth.push(d);
  }
  const offSaturdays = new Set([saturdaysInMonth[1], saturdaysInMonth[3]].filter(d => d !== undefined));
  const holidaySet = new Set(holidayList || []);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  let wd = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow === 0) continue; // Sunday
    if (offSaturdays.has(d)) continue; // 2nd/4th Saturday
    if (holidaySet.has(`${monthKey}-${String(d).padStart(2, '0')}`)) continue; // state bank holiday
    wd++;
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

  // WD[monthKey][city] — working days differ by city since each city's state bank holidays differ.
  const CITIES_IN_ROSTER = [...new Set(IDENTITY.map(([, , city]) => city))];
  const WD = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    const throughDay = key === currentMonthKey ? todayDay : null;
    WD[key] = {};
    CITIES_IN_ROSTER.forEach(city => {
      WD[key][city] = workingDaysInRange(yy, mm, throughDay, CITY_HOLIDAYS[city]);
    });
  });

  const MONTH_ABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_LABEL = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    MONTH_LABEL[key] = `${MONTH_ABBR[mm]}-${String(yy).slice(2)}` + (key === currentMonthKey ? ' (MTD)' : '');
  });

  const agentIds = IDENTITY.map(([id]) => id);
  const agentInList = sqlList(agentIds);

  // Oro 2.0's visits/gbs_visits key on agent_auth_id, which needs the override for the 3 APs above.
  const oro2AuthIds = agentIds.map(id => AUTH_ID_OVERRIDE[id] || id);
  const oro2AgentInList = sqlList(oro2AuthIds);
  const authIdToAgentId = new Map(agentIds.map(id => [AUTH_ID_OVERRIDE[id] || id, id]));

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
    SELECT agent_auth_id, visit_time::date AS day, visit_status, loan_subtype, release_type, visit_type
    FROM visits
    WHERE agent_auth_id IN (${oro2AgentInList})
      AND visit_time >= '2026-01-01'
      AND (
        (visit_type='GR' AND visit_status IN ('VISIT_COMPLETED','RELEASE_VISIT_COMPLETED'))
        OR (visit_status='VISIT_COMPLETED' AND loan_subtype IN ('FRESH_LOAN','TAKEOVER'))
        OR (visit_status = 'VISIT_CANCELLED' AND cancelled_by_auth_id = customer_auth_id)
      )
  `;
  const visitRows = await runQuery(ORO2_DB_ID, visitQuery);
  console.log(`  ${visitRows.length} visit rows`);

  visitRows.forEach(([rawAgent, day, status, loanSubtype, releaseType, visitType]) => {
    const agent = authIdToAgentId.get(rawAgent) || rawAgent;
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
    WHERE agent_auth_id IN (${oro2AgentInList}) AND status = 'VISIT_COMPLETED' AND visit_time >= '2026-01-01'
  `;
  const gbsRows = await runQuery(ORO2_DB_ID, gbsQuery);
  console.log(`  ${gbsRows.length} gbs_visits rows`);
  gbsRows.forEach(([rawAgent, day]) => addCount(authIdToAgentId.get(rawAgent) || rawAgent, day, 'goldSale'));

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
    // Excludes visits already scored as Fresh Loan/Takeover/Release/Pvt sale — verified 2026-07-29 that
    // 100% of self-sourced completions matched here were ALSO a loan/GR completion, meaning every point
    // awarded under this category was double-counting a visit already scored elsewhere. Self-source Cx Met
    // should only fire for a genuine customer-met visit that isn't itself one of those completions.
    const completedVisitRows = await runQuery(ORO2_DB_ID, `
      SELECT sales_visit_id, visit_time::date AS day
      FROM visits
      WHERE sales_visit_id IN (${salesVisitIdList}) AND visit_status = 'VISIT_COMPLETED'
        AND (loan_subtype IS NULL OR loan_subtype NOT IN ('FRESH_LOAN','TAKEOVER'))
        AND (visit_type IS NULL OR visit_type != 'GR')
    `);
    console.log(`  ${completedVisitRows.length} of those reached VISIT_COMPLETED without already being scored elsewhere`);
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
    .replace('__ROSTER_RESOLVED__', String(IDENTITY.length))
    .replace('__ROSTER_TOTAL__', String(ROSTER_TOTAL))
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
