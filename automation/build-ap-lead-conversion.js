// Rebuild of the AP Lead Generation & Conversion report — a companion to the AP Rubric report focused
// specifically on lead volume/conversion, since "how many partners clear the Lead Bonus gates, and by how
// much" comes up on its own often enough to deserve its own dashboard rather than digging through the AP
// Rubric leaderboard's Lead conv % column city by city.
//
// Roster is read directly out of build-ap-rubric.js's IDENTITY array (not duplicated here) so the two
// reports can never drift onto different rosters — this script and the AP Rubric report should always
// agree on exactly who's in scope.
//
// Lead Bonus reference (must match automation/ap-rubric-template.html exactly): +10 pts if an AP averages
// 100+ distinct leads/month AND has 2%+ of those leads convert to a loan, over the selected window.
//
// Required environment variables (same GitHub Actions secrets as the AP/SP rubrics):
//   METABASE_URL, METABASE_API_KEY, QUALI_DB_ID (Quali-prod: lead/lead_submissions)

const fs = require('fs');
const path = require('path');

const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const QUALI_DB_ID = parseInt(process.env.QUALI_DB_ID, 10);

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
  // Same guard as build-ap-rubric.js: Metabase silently truncates native queries at ~2,000 rows and
  // reports it via data.rows_truncated. Fail loudly rather than publish a partial pull.
  if (json.data.rows_truncated) {
    throw new Error(`Metabase truncated this query's results (rows_truncated=${json.data.rows_truncated}) — query needs to aggregate further. Query:\n${query.slice(0, 300)}`);
  }
  return json.data.rows;
}

// Pull the roster straight from build-ap-rubric.js's IDENTITY array so the two reports can't drift onto
// different rosters over time.
const apRubricSrc = fs.readFileSync(path.join(__dirname, 'build-ap-rubric.js'), 'utf8');
const identityMatch = apRubricSrc.match(/const IDENTITY = \[([\s\S]*?)\n\];/);
if (!identityMatch) throw new Error('Could not find IDENTITY array in build-ap-rubric.js — has its format changed?');
const IDENTITY_FULL = eval('[' + identityMatch[1] + ']'); // [id, name, city, designation, doj]
const IDENTITY = IDENTITY_FULL.map(([id, name, city]) => [id, name, city]); // this report only needs id/name/city

async function main() {
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(nowUtc.getTime() + istOffsetMs);
  const todayStr = ist.toISOString().slice(0, 10);
  const currentMonthKey = todayStr.slice(0, 7);

  const months = [];
  let y = 2026, m = 1;
  while (`${y}-${String(m).padStart(2, '0')}` <= currentMonthKey) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  const MONTH_ABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_LABEL = {};
  months.forEach(key => {
    const [yy, mm] = key.split('-').map(Number);
    MONTH_LABEL[key] = `${MONTH_ABBR[mm]}-${String(yy).slice(2)}` + (key === currentMonthKey ? ' (MTD)' : '');
  });

  const agentIds = IDENTITY.map(([id]) => id);

  // Aggregated in SQL by (submitted_by, month) — never fetch one row per lead (tens of thousands org-wide),
  // see the rows_truncated guard above and build-ap-rubric.js's history for why that matters.
  console.log(`Fetching lead_submissions (Quali-prod) for ${agentIds.length} APs...`);
  const leadSubmissionsQuery = `
    WITH per_lead AS (
      SELECT submitted_by, lead_id, min(submitted_at)::date AS day, bool_or(acceptance_status = 'YES') AS approved
      FROM lead_submissions
      WHERE submitted_by IN (${agentIds.join(',')}) AND submitted_at >= '2026-01-01'
      GROUP BY submitted_by, lead_id
    )
    SELECT pl.submitted_by, to_char(pl.day, 'YYYY-MM') AS month,
      count(*) FILTER (WHERE pl.approved) AS new_leads,
      count(*) FILTER (WHERE NOT pl.approved) AS existing_leads,
      count(*) FILTER (WHERE l.conversion_id IS NOT NULL) AS converted_leads
    FROM per_lead pl JOIN lead l ON l.id = pl.lead_id
    GROUP BY pl.submitted_by, to_char(pl.day, 'YYYY-MM')
  `;
  const leadRows = await runQuery(QUALI_DB_ID, leadSubmissionsQuery);
  console.log(`  ${leadRows.length} agent-month lead_submissions rows`);

  const keptIds = new Set(agentIds);
  const RAW = leadRows
    .map(([agent, month, newCount, existingCount, convertedCount]) => [String(agent), month, newCount, existingCount, convertedCount])
    .filter(([agent, month]) => keptIds.has(agent) && months.includes(month));

  console.log(`Built ${RAW.length} agent-month rows.`);

  const agentsWithAnyActivity = new Set(RAW.map(r => r[0])).size;
  const coverage = agentIds.length ? agentsWithAnyActivity / agentIds.length : 0;
  if (coverage < 0.3) {
    // Lower bar than the AP Rubric's 0.5 — plenty of real APs genuinely submit zero leads in a given
    // window (this report shows that explicitly), so only trip on a truly implausible org-wide collapse.
    throw new Error(`Only ${agentsWithAnyActivity} of ${agentIds.length} APs (${(coverage * 100).toFixed(0)}%) have any lead_submissions across ${months[0]}–${currentMonthKey} — refusing to publish. Check runQuery's rows_truncated guard.`);
  }

  const monthCheckboxes = months.map(key => {
    const checked = key === currentMonthKey ? ' checked' : '';
    return `          <label><input type="checkbox" value="${key}"${checked}> ${MONTH_LABEL[key]}</label>`;
  }).join('\n');

  const refreshedAt = ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
  const statusLine = `Quali-prod lead_submissions/lead (live) · ${IDENTITY.length} active APs, Chennai/Bengaluru/Hyderabad/Pune`;

  let template = fs.readFileSync(path.join(__dirname, 'ap-lead-conversion-template.html'), 'utf8');
  template = template
    .replace('__MONTH_CHECKBOXES__', monthCheckboxes)
    .replace('__STATUS_LINE__', statusLine)
    .replace('__RAW_DATA__', JSON.stringify(RAW))
    .replace('__IDENTITY_DATA__', JSON.stringify(IDENTITY))
    .replace('__MONTH_LABEL_DATA__', JSON.stringify(MONTH_LABEL))
    .replace('__REFRESHED_AT__', refreshedAt);

  fs.writeFileSync(path.join(__dirname, '..', 'ap_lead_conversion_report.html'), template);
  console.log(`Wrote ap_lead_conversion_report.html — ${RAW.length} rows, refreshed ${refreshedAt}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
