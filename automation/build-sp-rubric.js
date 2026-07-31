// Weekly rebuild of the SP Rubric Report (runs Sundays 8 PM IST via GitHub Actions).
// Pulls fresh visit/loan/lead data live from Metabase (no more manual "Sales Table" Excel export) and
// rewrites sp_rubric_report.html.
//
// Source of truth, verified against the last manually-built Excel export before switching over:
//   - Cx Met / Visits Raised: Quali-prod.sales_visit (agent_auth_id, status, visit_time)
//   - Loan completion: sales_visit.lead_id -> Quali-prod.lead.conversion_id -> Oro production loans.id
//     (lead.conversion_id is non-null exactly when a loan was actually created off that lead)
//   - Self-sourced leads: Quali-prod.lead where created_by_oro_id matches the SP's own agent id
//
// The roster (agent id -> name/city) is NOT pulled live — it's the curated, tenure-filter-free list of
// 60 active Tier-1 SPs (Bengaluru/Hyderabad/Pune) agreed on 2026-07-23, hardcoded below. When someone
// joins, leaves, or changes city, update the IDENTITY array by hand.
//
// Required environment variables (set as GitHub Actions secrets — same ones the CO Walk-ins job uses):
//   METABASE_URL       e.g. https://oro.metabaseapp.com
//   METABASE_API_KEY   an API key created in Metabase Admin > Settings > API Keys
//   QUALI_DB_ID        Metabase database id for "Quali-prod" (sales_visit/lead live here)
//   ORO2_DB_ID         Metabase database id for "Oro 2.0" (loans lives here — same physical DB as "Oro")

const fs = require('fs');
const path = require('path');

const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const QUALI_DB_ID = parseInt(process.env.QUALI_DB_ID, 10);
const ORO2_DB_ID = parseInt(process.env.ORO2_DB_ID, 10);

if (!METABASE_URL || !METABASE_API_KEY || !QUALI_DB_ID) {
  console.error('Missing required environment variables. Need METABASE_URL, METABASE_API_KEY, QUALI_DB_ID.');
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

// [agent_auth_id, name, city] — Bengaluru/Hyderabad/Pune, no tenure minimum, as of 2026-07-23.
// Chennai's Gowtham B (82483) is deliberately included so any future re-inclusion of Chennai only
// requires adding 'Chennai' back to CITIES in the template, not re-deriving the roster.
const IDENTITY = [
  ["2525","Sridhar S","Bengaluru"],["5537","Ramachari Nv","Bengaluru"],["33792","Vuda Narayana Rao","Hyderabad"],
  ["33799","Kembhasaram Pavan Kumar","Hyderabad"],["43896","Nagarjuna N","Bengaluru"],["46963","Anugula Pranith Kumar Reddy","Hyderabad"],
  ["47546","Ganta Ayyappa Swamy","Hyderabad"],["47917","Madapa Anil","Hyderabad"],["50323","Angothu Narendar","Hyderabad"],
  ["52077","Gummadi Ramesh","Hyderabad"],["53219","Sreedhar Kamitin","Hyderabad"],["57102","M Manigandan","Bengaluru"],
  ["60846","Pakhare Yuvraj Balasaheb","Pune"],["63747","Guguloth Venkatesh","Hyderabad"],["63751","Ramagiri Sunil","Hyderabad"],
  ["63754","Tanneeru Vijay Kumar","Hyderabad"],["63986","Bitla Naresh","Hyderabad"],["64250","Shaik Sajid Ali","Hyderabad"],
  ["64382","Paspulla Karthik","Hyderabad"],["65516","Sanjeev P","Hyderabad"],["66203","Imran S","Bengaluru"],
  ["66789","Kashireddy Uday Kiran Reddy","Hyderabad"],["66790","Bijja Vijaya Kumar","Hyderabad"],["68968","Srimalla Naresh","Hyderabad"],
  ["70462","Medida Praveen Kumar","Hyderabad"],["72083","Chinthalathadem Sai Kiran","Hyderabad"],["72107","Tejas V","Bengaluru"],
  ["72222","Ramavath Naga","Hyderabad"],["72503","Nanjunda F Talwar","Bengaluru"],["73112","Arun Kumar","Bengaluru"],
  ["73286","Pavan Kumar S","Bengaluru"],["73462","Nandisha A N","Bengaluru"],["73897","Sarvesh Manoj Dalu","Pune"],
  ["76922","Vaibhav Tukaram Shirure","Pune"],["77098","Tarun Prem Khemlani","Hyderabad"],["77107","Devaraju J","Hyderabad"],
  ["77431","Banda Sampath Kumar","Hyderabad"],["77460","Shaik Khaja Mohiddin","Hyderabad"],["77463","Bankh Srikanth Reddy","Hyderabad"],
  ["77467","Chillukamari Sridhar","Hyderabad"],["77470","Yerukala Uday Kiran","Hyderabad"],["77477","Banapuram Venkata Sai","Hyderabad"],
  ["77480","Pavan Kumar Reddy M","Bengaluru"],["77587","Kashif Khan","Bengaluru"],["77616","Ajmal Khan","Bengaluru"],
  ["78233","Jonak Vamshi","Hyderabad"],["78493","Tumalapalli Chandrashekar","Hyderabad"],["82065","Swapnil Tonde","Pune"],
  ["82483","Gowtham B","Chennai"],["84332","Devaraju J","Hyderabad"],["84320","Srikanth K","Bengaluru"],
  ["84333","Gerapramod K","Hyderabad"],["89925","Nagaraja C","Bengaluru"],["90721","Nikhil M","Hyderabad"],
  ["90723","Nagaraju K","Hyderabad"],["90741","Praveen S","Bengaluru"],["92067","Tejas Vg","Pune"],
  ["92952","Sumit Rk","Pune"],["93151","Ambarisha V","Bengaluru"],["93448","Harshad Sa","Pune"],
  ["93655","Aniketgopal S","Pune"],
];

// VISIT_COMPLETED_GBS added 2026-07-31 — a completed Gold Buy-Sell customer visit (87 rows Jan-Aug 2026,
// 21 SPs) that was previously scoring nothing as a Cx Met despite being a genuine completed customer visit.
const CX_MET_STATUSES = ['VISIT_COMPLETED_GL','VISIT_COMPLETED_BRL','VISIT_COMPLETED_GBS','MAY_TXN','VISIT_CANCELLED_NIAM','VISIT_CANCELLED_IE','VISIT_CANCELLED_GS','MAY_TXN_RESCHEDULED','MAY_TXN_RNR','VISIT_CANCELLED_CC'];
const RAISED_STATUSES = ['VISIT_COMPLETED_BRL','VISIT_COMPLETED_GL','VISIT_CANCELLED_CC'];

function sqlList(arr) { return arr.map(v => `'${v}'`).join(','); }

// 2026 state-wise bank holiday calendars (source: Federal Bank's 2026 holiday list, supplied 2026-07-31).
// Only Karnataka/Telangana/Maharashtra matter for this roster's Tier-1 cities (Bengaluru/Hyderabad/Pune).
const KARNATAKA_HOLIDAYS = ['2026-01-15','2026-01-26','2026-02-15','2026-03-19','2026-03-21','2026-03-31','2026-04-03','2026-04-14','2026-04-20','2026-05-01','2026-05-28','2026-06-26','2026-08-15','2026-08-26','2026-09-14','2026-10-02','2026-10-10','2026-10-20','2026-10-21','2026-10-25','2026-11-01','2026-11-08','2026-11-10','2026-11-27','2026-12-25'];
const TELANGANA_HOLIDAYS = ['2026-01-15','2026-01-26','2026-02-15','2026-03-03','2026-03-19','2026-03-21','2026-03-27','2026-04-01','2026-04-03','2026-04-05','2026-04-14','2026-05-01','2026-05-27','2026-06-26','2026-08-15','2026-08-26','2026-09-04','2026-09-14','2026-10-02','2026-10-20','2026-11-08','2026-11-24','2026-12-25'];
const MAHARASHTRA_HOLIDAYS = ['2026-01-26','2026-02-15','2026-02-19','2026-03-03','2026-03-19','2026-03-21','2026-03-26','2026-03-31','2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26','2026-08-15','2026-08-26','2026-09-14','2026-10-02','2026-10-20','2026-11-08','2026-11-10','2026-11-24','2026-12-25'];
const CITY_HOLIDAYS = { Bengaluru: KARNATAKA_HOLIDAYS, Hyderabad: TELANGANA_HOLIDAYS, Pune: MAHARASHTRA_HOLIDAYS };

// Working days = calendar days minus Sundays minus the 2nd and 4th Saturday of the month (Oro's actual
// off-day policy — fixed 2026-07-31, this previously only removed Sundays and never removed the two
// Saturdays, over-counting every month by 2 days, e.g. January read 27 instead of 25) minus that city's
// state bank holidays landing on an otherwise-working day. For the current (in-progress) month, only count
// days up to and including "today" (IST) — matches how "July MTD" worked in the manual-export version.
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
  const todayStr = ist.toISOString().slice(0, 10); // YYYY-MM-DD, IST calendar date
  const currentMonthKey = todayStr.slice(0, 7); // YYYY-MM
  const todayDay = parseInt(todayStr.slice(8, 10), 10);

  // Month range: Jan 2026 through the current month.
  const months = [];
  let y = 2026, m = 1;
  while (`${y}-${String(m).padStart(2, '0')}` <= currentMonthKey) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  // WD[monthKey][city] — working days differ by city since each city's state bank holidays differ.
  const WD = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    const throughDay = key === currentMonthKey ? todayDay : null;
    WD[key] = {};
    Object.keys(CITY_HOLIDAYS).forEach(city => {
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

  console.log(`Fetching sales_visit + lead.conversion_id for ${agentIds.length} SPs, ${months[0]} through ${currentMonthKey}...`);
  const visitQuery = `
    SELECT sv.agent_auth_id, sv.visit_time::date AS visit_day, sv.status,
           (l.conversion_id IS NOT NULL) AS has_loan
    FROM sales_visit sv
    LEFT JOIN lead l ON l.id = sv.lead_id
    WHERE sv.agent_auth_id IN (${agentInList})
      AND sv.visit_time >= '2026-01-01'
      AND sv.status IN (${sqlList(Array.from(new Set([...CX_MET_STATUSES, ...RAISED_STATUSES])))})
  `;
  const visitRows = await runQuery(QUALI_DB_ID, visitQuery);
  console.log(`  ${visitRows.length} visit rows`);

  console.log('Fetching self-sourced leads (day-level, for the daily effort cap)...');
  const leadQuery = `
    SELECT created_by_oro_id, created_at::date AS lead_day, count(*) AS n
    FROM lead
    WHERE created_by_oro_id IN (${agentInList}) AND created_at >= '2026-01-01'
    GROUP BY created_by_oro_id, lead_day
  `;
  const leadRows = await runQuery(QUALI_DB_ID, leadQuery);
  console.log(`  ${leadRows.length} agent-day lead rows`);

  // agent|day -> { cxMet, raised, loans } from visit-level rows.
  const dayStats = new Map();
  const CX_MET_SET = new Set(CX_MET_STATUSES);
  const RAISED_SET = new Set(RAISED_STATUSES);
  visitRows.forEach(([agent, day, status, hasLoan]) => {
    const key = `${agent}|${day}`;
    const cur = dayStats.get(key) || { cxMet: 0, raised: 0, loans: 0 };
    if (CX_MET_SET.has(status)) cur.cxMet++;
    if (RAISED_SET.has(status)) {
      cur.raised++;
      if (hasLoan) cur.loans++;
    }
    dayStats.set(key, cur);
  });

  // agent|day -> lead count.
  const leadsByDay = new Map();
  leadRows.forEach(([agent, day, n]) => { leadsByDay.set(`${agent}|${day}`, Number(n)); });

  // Union of all agent|day keys that have either visit or lead activity.
  const allDayKeys = new Set([...dayStats.keys(), ...leadsByDay.keys()]);

  // agent|month -> { leads, cxMet, raised, loans, capped }
  const monthAgg = new Map();
  allDayKeys.forEach(key => {
    const sep = key.lastIndexOf('|');
    const agent = key.slice(0, sep);
    const day = key.slice(sep + 1); // YYYY-MM-DD
    const month = day.slice(0, 7);
    if (!months.includes(month)) return;
    const stats = dayStats.get(key) || { cxMet: 0, raised: 0, loans: 0 };
    const leads = leadsByDay.get(key) || 0;
    const cappedUnit = Math.min(stats.cxMet + leads / 2, 6);

    const mkey = `${agent}|${month}`;
    const cur = monthAgg.get(mkey) || { leads: 0, cxMet: 0, raised: 0, loans: 0, capped: 0 };
    cur.leads += leads;
    cur.cxMet += stats.cxMet;
    cur.raised += stats.raised;
    cur.loans += stats.loans;
    cur.capped += cappedUnit;
    monthAgg.set(mkey, cur);
  });

  const RAW = [];
  agentIds.forEach(agent => {
    months.forEach(month => {
      const mkey = `${agent}|${month}`;
      const a = monthAgg.get(mkey);
      if (!a) return; // no activity at all this month — omit, same convention as the original data
      RAW.push([agent, month, a.leads, a.cxMet, a.raised, a.loans, Math.round(a.capped * 10) / 10]);
    });
  });
  console.log(`Built ${RAW.length} agent-month rows.`);

  const monthCheckboxes = months.map(key => {
    const checked = key === currentMonthKey ? ' checked' : '';
    return `          <label><input type="checkbox" value="${key}"${checked}> ${MONTH_LABEL[key]}</label>`;
  }).join('\n');

  const refreshedAt = ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
  const statusLine = `Quali-prod.sales_visit ⋈ lead ⋈ loans (live) · ${IDENTITY.filter(([, , c]) => c !== 'Chennai').length} active, Tier-1 SPs (Bengaluru/Hyderabad/Pune, no tenure minimum)`;

  let template = fs.readFileSync(path.join(__dirname, 'sp-rubric-template.html'), 'utf8');
  template = template
    .replace('__MONTH_CHECKBOXES__', monthCheckboxes)
    .replace('__STATUS_LINE__', statusLine)
    .replace('__RAW_DATA__', JSON.stringify(RAW))
    .replace('__IDENTITY_DATA__', JSON.stringify(IDENTITY))
    .replace('__WD_DATA__', JSON.stringify(WD))
    .replace('__MONTH_LABEL_DATA__', JSON.stringify(MONTH_LABEL))
    .replace('__REFRESHED_AT__', refreshedAt);

  fs.writeFileSync(path.join(__dirname, '..', 'sp_rubric_report.html'), template);
  console.log(`Wrote sp_rubric_report.html — ${RAW.length} rows, refreshed ${refreshedAt}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
