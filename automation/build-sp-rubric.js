// Weekly rebuild of the SP Rubric Report (runs Sundays 8 PM IST via GitHub Actions).
// Pulls fresh visit/loan/lead data live from Metabase (no more manual "Sales Table" Excel export) and
// rewrites sp_rubric_report.html.
//
// Source of truth, verified against the last manually-built Excel export before switching over:
//   - Cx Met / Visits Raised: Quali-prod.sales_visit (agent_auth_id, status, visit_time)
//   - Loan completion: sales_visit.lead_id -> Quali-prod.lead.conversion_id -> Oro production loans.id
//     (lead.conversion_id is non-null exactly when a loan was actually created off that lead)
//   - Self-sourced leads: Quali-prod.lead_submissions where submitted_by matches the SP's own agent id.
//     Changed 2026-07-31 (second pass, matching the AP report's identical change): was
//     Quali-prod.lead.created_by_oro_id, counting every lead flat. Now deduped by lead_id (a lead
//     resubmitted many times counts once, attributed to its first submission's day) and weighted — a lead
//     that was ever accepted counts as 1 full "lead" toward the effort formula below, one that was never
//     accepted (a resubmission of an already-known lead) counts as half — same accept/reject-weighted
//     logic as the AP report's Lead Generation, so a partner can't inflate effort by repeatedly resubmitting
//     the same lead.
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

// [agent_auth_id, name, city, doj] — Bengaluru/Hyderabad/Pune, no tenure minimum, as of 2026-07-23.
// Chennai's Gowtham B (82483) is deliberately included so any future re-inclusion of Chennai only
// requires adding 'Chennai' back to CITIES in the template, not re-deriving the roster.
// doj resolved 2026-08-01 by matching name (+ city where ambiguous) against the full HR export Aditya
// supplied; null where unresolved (treated as long-tenured, never flagged as a new joiner) rather than
// guessed. Kembhasaram Pavan Kumar (33799): no matching name found in the HR export. Devaraju J (77107
// AND 84332): two different agent ids share this exact name in Hyderabad but only one HR record exists
// ("Jangala Devaraju") — left both null rather than risk attributing it to the wrong person. Srikanth K
// (84320), Gerapramod K (84333), Nagaraju K (90723): matched by name but the HR sheet shows them
// "Abscond" — used their DOJ anyway since they're clearly active in the live visit data (same
// stale-HR-status pattern the AP report ran into), but worth a second look if it ever looks wrong.
const IDENTITY = [
  ["2525","Sridhar S","Bengaluru","2021-12-02"],["5537","Ramachari Nv","Bengaluru","2022-07-13"],["33792","Vuda Narayana Rao","Hyderabad","2024-02-09"],
  ["33799","Kembhasaram Pavan Kumar","Hyderabad",null],["43896","Nagarjuna N","Bengaluru","2024-10-01"],["46963","Anugula Pranith Kumar Reddy","Hyderabad","2024-11-16"],
  ["47546","Ganta Ayyappa Swamy","Hyderabad","2024-12-09"],["47917","Madapa Anil","Hyderabad","2025-01-02"],["50323","Angothu Narendar","Hyderabad","2025-01-27"],
  ["52077","Gummadi Ramesh","Hyderabad","2025-01-28"],["53219","Sreedhar Kamitin","Hyderabad","2025-02-03"],["57102","M Manigandan","Bengaluru","2025-04-12"],
  ["60846","Pakhare Yuvraj Balasaheb","Pune","2025-05-22"],["63747","Guguloth Venkatesh","Hyderabad","2025-06-23"],["63751","Ramagiri Sunil","Hyderabad","2025-05-07"],
  ["63754","Tanneeru Vijay Kumar","Hyderabad","2025-06-23"],["63986","Bitla Naresh","Hyderabad","2025-06-12"],["64250","Shaik Sajid Ali","Hyderabad","2025-06-23"],
  ["64382","Paspulla Karthik","Hyderabad","2025-06-26"],["65516","Sanjeev P","Hyderabad","2025-07-14"],["66203","Imran S","Bengaluru","2025-07-01"],
  ["66789","Kashireddy Uday Kiran Reddy","Hyderabad","2025-07-21"],["66790","Bijja Vijaya Kumar","Hyderabad","2025-07-15"],["68968","Srimalla Naresh","Hyderabad","2025-08-07"],
  ["70462","Medida Praveen Kumar","Hyderabad","2024-05-02"],["72083","Chinthalathadem Sai Kiran","Hyderabad","2025-10-07"],["72107","Tejas V","Bengaluru","2025-10-06"],
  ["72222","Ramavath Naga","Hyderabad","2025-10-06"],["72503","Nanjunda F Talwar","Bengaluru","2025-10-09"],["73112","Arun Kumar","Bengaluru","2025-10-14"],
  ["73286","Pavan Kumar S","Bengaluru","2025-10-06"],["73462","Nandisha A N","Bengaluru","2025-09-26"],["73897","Sarvesh Manoj Dalu","Pune","2025-10-28"],
  ["76922","Vaibhav Tukaram Shirure","Pune","2025-12-01"],["77098","Tarun Prem Khemlani","Hyderabad","2025-11-17"],["77107","Devaraju J","Hyderabad",null],
  ["77431","Banda Sampath Kumar","Hyderabad","2025-11-17"],["77460","Shaik Khaja Mohiddin","Hyderabad","2025-11-17"],["77463","Bankh Srikanth Reddy","Hyderabad","2025-12-01"],
  ["77467","Chillukamari Sridhar","Hyderabad","2025-11-17"],["77470","Yerukala Uday Kiran","Hyderabad","2025-11-17"],["77477","Banapuram Venkata Sai","Hyderabad","2025-11-20"],
  ["77480","Pavan Kumar Reddy M","Bengaluru","2025-11-10"],["77587","Kashif Khan","Bengaluru","2025-11-10"],["77616","Ajmal Khan","Bengaluru","2025-11-10"],
  ["78233","Jonak Vamshi","Hyderabad","2025-12-09"],["78493","Tumalapalli Chandrashekar","Hyderabad","2025-11-17"],["82065","Swapnil Tonde","Pune","2026-01-08"],
  ["82483","Gowtham B","Chennai","2026-01-22"],["84332","Devaraju J","Hyderabad",null],["84320","Srikanth K","Bengaluru","2026-02-13"],
  ["84333","Gerapramod K","Hyderabad","2026-02-12"],["89925","Nagaraja C","Bengaluru","2026-03-31"],["90721","Nikhil M","Hyderabad","2026-02-24"],
  ["90723","Nagaraju K","Hyderabad","2026-04-09"],["90741","Praveen S","Bengaluru","2026-04-29"],["92067","Tejas Vg","Pune","2026-05-06"],
  ["92952","Sumit Rk","Pune","2026-05-06"],["93151","Ambarisha V","Bengaluru","2026-06-02"],["93448","Harshad Sa","Pune","2026-05-20"],
  ["93655","Aniketgopal S","Pune","2026-05-20"],
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

  console.log('Fetching self-sourced lead_submissions (day-level, for the daily effort cap)...');
  const leadQuery = `
    WITH per_lead AS (
      SELECT submitted_by, lead_id, min(submitted_at)::date AS day, bool_or(acceptance_status = 'YES') AS approved
      FROM lead_submissions
      WHERE submitted_by IN (${agentInList}) AND submitted_at >= '2026-01-01'
      GROUP BY submitted_by, lead_id
    )
    SELECT submitted_by, day,
      count(*) FILTER (WHERE approved) AS new_leads,
      count(*) FILTER (WHERE NOT approved) AS existing_leads
    FROM per_lead
    GROUP BY submitted_by, day
  `;
  const leadRows = await runQuery(QUALI_DB_ID, leadQuery);
  console.log(`  ${leadRows.length} agent-day distinct-lead rows`);

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

  // agent|day -> { newLeads, existingLeads } (distinct leads, deduped by lead_id above).
  const leadsByDay = new Map();
  leadRows.forEach(([agent, day, newLeads, existingLeads]) => {
    leadsByDay.set(`${agent}|${day}`, { newLeads: Number(newLeads), existingLeads: Number(existingLeads) });
  });

  // Union of all agent|day keys that have either visit or lead activity.
  const allDayKeys = new Set([...dayStats.keys(), ...leadsByDay.keys()]);

  // agent|month -> { newLeads, existingLeads, cxMet, raised, loans, capped }
  const monthAgg = new Map();
  allDayKeys.forEach(key => {
    const sep = key.lastIndexOf('|');
    const agent = key.slice(0, sep);
    const day = key.slice(sep + 1); // YYYY-MM-DD
    const month = day.slice(0, 7);
    if (!months.includes(month)) return;
    const stats = dayStats.get(key) || { cxMet: 0, raised: 0, loans: 0 };
    const { newLeads, existingLeads } = leadsByDay.get(key) || { newLeads: 0, existingLeads: 0 };
    // Existing (never-accepted, i.e. resubmitted) leads count at half weight toward the effort formula —
    // same accept/reject-weighted logic as the AP report's Lead Generation, so repeatedly resubmitting an
    // already-known lead can't inflate a day's effort the way a genuinely new lead does.
    const weightedLeads = newLeads + existingLeads * 0.5;
    // Daily target lowered 6 -> 5 units/day 2026-08-01, per Aditya's decision.
    const cappedUnit = Math.min(stats.cxMet + weightedLeads / 2, 5);

    const mkey = `${agent}|${month}`;
    const cur = monthAgg.get(mkey) || { newLeads: 0, existingLeads: 0, cxMet: 0, raised: 0, loans: 0, capped: 0 };
    cur.newLeads += newLeads;
    cur.existingLeads += existingLeads;
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
      RAW.push([agent, month, a.newLeads, a.existingLeads, a.cxMet, a.raised, a.loans, Math.round(a.capped * 10) / 10]);
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
