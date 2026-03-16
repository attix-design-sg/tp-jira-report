'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// --- Config ---
const JIRA_BASE = 'https://tsgs.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || 'gicci.goh@attix.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BOARD_ID = 777;        // TP board (TradeAlgo Product)
const PROJECT_KEY = 'TP';

const WORKFLOW = ['To Do','Research','PRD','Mockup','Data','Design','Design Approval','Dev','LLM','QA','Staging','Prod','GTM','Done'];
const WORKFLOW_IDX = Object.fromEntries(WORKFLOW.map((s, i) => [s, i]));

const DISCOVERY_STATUSES = new Set(['To Do','Research','PRD']);
const DESIGN_STATUSES    = new Set(['Mockup','Data','Design','Design Approval']);
const DELIVERY_STATUSES  = new Set(['Dev','LLM','QA','Staging','Prod','GTM']);

// --- Jira helpers ---
function authHeader() {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`;
}

async function jiraFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira ${res.status} ${url}\n${body}`);
  }
  return res.json();
}

async function jiraFetchAll(url, itemsKey = 'issues') {
  let startAt = 0;
  let total = Infinity;
  const all = [];
  while (all.length < total) {
    const sep = url.includes('?') ? '&' : '?';
    const data = await jiraFetch(`${url}${sep}startAt=${startAt}&maxResults=100`);
    const items = data[itemsKey] ?? data.values ?? [];
    if (items.length === 0) break;
    all.push(...items);
    total = data.total ?? items.length;
    startAt += items.length;
    if (items.length < 100) break;
  }
  return all;
}

// --- Date helpers ---
function todaySGT() {
  // Returns YYYY-MM-DD in Asia/Singapore timezone
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function daysBetween(d1, d2) {
  return Math.round(Math.abs(new Date(d2) - new Date(d1)) / 86400000);
}

// --- Workflow helpers ---
function workflowIndex(status) {
  return WORKFLOW_IDX[status] ?? -1;
}

function isForward(from, to) {
  const fi = workflowIndex(from);
  const ti = workflowIndex(to);
  return fi >= 0 && ti > fi;
}

function isBackward(from, to) {
  const fi = workflowIndex(from);
  const ti = workflowIndex(to);
  return fi >= 0 && ti >= 0 && ti < fi;
}

function getStatus(issue) {
  return issue.fields?.status?.name ?? 'Unknown';
}

function getAssignee(issue) {
  return issue.fields?.assignee?.displayName ?? '__unassigned__';
}

// --- Jira API calls ---
async function resolveBoardId() {
  console.log(`  Board ID: ${BOARD_ID} (TP board)`);
  return BOARD_ID;
}

async function getActiveSprint(boardId) {
  const data = await jiraFetch(`${JIRA_BASE}/rest/agile/1.0/board/${boardId}/sprint?state=active`);
  return data.values?.[0] ?? null;
}

async function getSprintIssues(sprintId) {
  return jiraFetchAll(
    `${JIRA_BASE}/rest/agile/1.0/sprint/${sprintId}/issue?expand=changelog&fields=summary,status,assignee,issuetype,priority,created`,
    'issues'
  );
}

async function getUpdatedTodayIssues() {
  const today = todaySGT();
  const jql = `project = ${PROJECT_KEY} AND updated >= "${today}" ORDER BY updated DESC`;
  return jiraFetchAll(
    `${JIRA_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&expand=changelog&fields=summary,status,assignee,issuetype,priority,created`,
    'issues'
  );
}

async function getBlockerIssues() {
  const jql = `sprint in openSprints() AND project = ${PROJECT_KEY} AND (flagged = Impediment OR status = "Blocked")`;
  return jiraFetchAll(
    `${JIRA_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary,assignee,status,priority,updated,comment`,
    'issues'
  );
}

async function getVelocityIssues(days) {
  const jql = `project = ${PROJECT_KEY} AND sprint in openSprints() AND status changed AFTER "-${days}d" AND NOT status changed TO "To Do"`;
  return jiraFetchAll(
    `${JIRA_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&expand=changelog&fields=summary,status,assignee`,
    'issues'
  );
}

// --- Module processors ---
function module1_SprintProgress(sprint, issues) {
  const breakdown = Object.fromEntries(WORKFLOW.map(s => [s, 0]));
  for (const issue of issues) {
    const s = getStatus(issue);
    breakdown[s] = (breakdown[s] ?? 0) + 1;
  }

  const total = issues.length;
  const done = breakdown['Done'] ?? 0;
  const completionRate = total > 0 ? done / total : 0;

  const start = new Date(sprint.startDate);
  const end   = new Date(sprint.endDate);
  const now   = new Date();
  const sprintLen  = Math.max(daysBetween(start, end), 1);
  const elapsed    = Math.min(daysBetween(start, now), sprintLen);
  const remaining  = Math.max(daysBetween(now, end), 0);
  const expectedRate = elapsed / sprintLen;

  return {
    sprint_id: sprint.id,
    sprint_name: sprint.name,
    start_date: sprint.startDate?.slice(0, 10),
    end_date: sprint.endDate?.slice(0, 10),
    days_remaining: remaining,
    total_issues: total,
    status_breakdown: breakdown,
    completion_rate: +completionRate.toFixed(3),
    expected_completion_rate: +expectedRate.toFixed(3),
    on_track: completionRate >= expectedRate
  };
}

function module2_DailyMovement(issues) {
  const today = todaySGT();
  const newTickets = [], progressed = [], regressed = [], completedToday = [];

  for (const issue of issues) {
    const createdDate = issue.fields?.created?.slice(0, 10);
    if (createdDate === today) {
      newTickets.push({ key: issue.key, summary: issue.fields.summary, assignee: getAssignee(issue), initial_status: getStatus(issue) });
    }

    for (const history of (issue.changelog?.histories ?? [])) {
      if (history.created?.slice(0, 10) !== today) continue;
      for (const item of (history.items ?? [])) {
        if (item.field !== 'status') continue;
        const entry = { key: issue.key, summary: issue.fields.summary, assignee: getAssignee(issue), from_status: item.fromString, to_status: item.toString, at: history.created };
        if (isForward(item.fromString, item.toString)) {
          progressed.push(entry);
          if (item.toString === 'Done') completedToday.push({ key: issue.key, summary: issue.fields.summary, assignee: getAssignee(issue), at: history.created });
        } else if (isBackward(item.fromString, item.toString)) {
          regressed.push(entry);
        }
      }
    }
  }

  return {
    date: today,
    summary: { total_touched: issues.length, new_tickets: newTickets.length, progressed: progressed.length, regressed: regressed.length, completed_today: completedToday.length },
    new_tickets: newTickets,
    progressed,
    regressed,
    completed_today: completedToday
  };
}

function module3_Blockers(blockerIssues, sprintIssues) {
  const now = new Date();

  const items = blockerIssues.map(issue => {
    const lastUpdate = new Date(issue.fields?.updated ?? now);
    const comments = issue.fields?.comment?.comments ?? [];
    const last = comments[comments.length - 1];
    return {
      key: issue.key,
      summary: issue.fields.summary,
      assignee: getAssignee(issue),
      status: getStatus(issue),
      priority: issue.fields?.priority?.name ?? 'Unknown',
      days_blocked: daysBetween(lastUpdate, now),
      last_comment: last?.body?.content?.[0]?.content?.[0]?.text ?? null,
      last_comment_by: last?.author?.displayName ?? null,
      last_comment_at: last?.created ?? null
    };
  });

  const stale = [];
  for (const issue of sprintIssues) {
    const status = getStatus(issue);
    if (status === 'Done' || status === 'To Do') continue;
    let lastMove = null;
    for (const h of (issue.changelog?.histories ?? [])) {
      for (const item of (h.items ?? [])) {
        if (item.field === 'status') lastMove = h.created;
      }
    }
    if (!lastMove) continue;
    const days = daysBetween(new Date(lastMove), now);
    if (days >= 3) {
      stale.push({ key: issue.key, summary: issue.fields.summary, assignee: getAssignee(issue), status, days_since_last_move: days, priority: issue.fields?.priority?.name ?? 'Unknown' });
    }
  }
  stale.sort((a, b) => b.days_since_last_move - a.days_since_last_move);

  return { total_blockers: items.length, items, stale_tickets: stale.slice(0, 5) };
}

function module4_Velocity(issues1d, issues5d) {
  function countForward(issues) {
    let progressed = 0, completed = 0;
    const seen = new Set();
    for (const issue of issues) {
      for (const h of (issue.changelog?.histories ?? [])) {
        for (const item of (h.items ?? [])) {
          if (item.field !== 'status') continue;
          if (!isForward(item.fromString, item.toString)) continue;
          const key = `${issue.key}::${item.toString}`;
          if (seen.has(key)) continue;
          seen.add(key);
          progressed++;
          if (item.toString === 'Done') completed++;
        }
      }
    }
    return { progressed, completed };
  }

  const v1 = countForward(issues1d);
  const v5 = countForward(issues5d);

  return {
    window_1d: { tickets_progressed: v1.progressed, tickets_completed: v1.completed },
    window_5d: { tickets_progressed: v5.progressed, tickets_completed: v5.completed, daily_avg_progressed: +(v5.progressed / 5).toFixed(1) }
  };
}

function module5_AssigneeVelocity(sprintIssues, issues1d, issues5d) {
  const map = {};

  for (const issue of sprintIssues) {
    const name = getAssignee(issue);
    const status = getStatus(issue);
    if (!map[name]) map[name] = { assigned_total: 0, done: 0, stage_breakdown: { discovery: 0, design: 0, delivery: 0, done: 0 }, tickets_progressed_1d: 0, tickets_progressed_5d: 0 };
    const a = map[name];
    a.assigned_total++;
    if (status === 'Done')                  { a.done++; a.stage_breakdown.done++; }
    else if (DISCOVERY_STATUSES.has(status)) a.stage_breakdown.discovery++;
    else if (DESIGN_STATUSES.has(status))    a.stage_breakdown.design++;
    else if (DELIVERY_STATUSES.has(status))  a.stage_breakdown.delivery++;
  }

  function addProgressions(issues, field) {
    for (const issue of issues) {
      const name = getAssignee(issue);
      if (!map[name]) continue;
      const moved = (issue.changelog?.histories ?? []).some(h =>
        (h.items ?? []).some(item => item.field === 'status' && isForward(item.fromString, item.toString))
      );
      if (moved) map[name][field]++;
    }
  }

  addProgressions(issues1d, 'tickets_progressed_1d');
  addProgressions(issues5d, 'tickets_progressed_5d');

  return Object.entries(map)
    .map(([assignee, d]) => ({ assignee, ...d, velocity_rate: d.assigned_total > 0 ? +(d.done / d.assigned_total).toFixed(3) : 0 }))
    .sort((a, b) => b.velocity_rate - a.velocity_rate);
}

function module6_CycleTime(sprintIssues) {
  const cycleTimes = [], byType = {};
  const stageTimes = { discovery: [], design: [], delivery: [] };

  for (const issue of sprintIssues) {
    if (getStatus(issue) !== 'Done') continue;
    const histories = issue.changelog?.histories ?? [];

    let firstActiveDate = null, doneDate = null;
    const firstEntryByStatus = {};

    for (const h of histories) {
      for (const item of (h.items ?? [])) {
        if (item.field !== 'status') continue;
        if (!firstEntryByStatus[item.toString]) firstEntryByStatus[item.toString] = h.created;
        if (item.toString !== 'To Do' && !firstActiveDate) firstActiveDate = h.created;
        if (item.toString === 'Done') doneDate = h.created;
      }
    }

    if (!firstActiveDate || !doneDate) continue;

    const total = daysBetween(firstActiveDate, doneDate);
    cycleTimes.push(total);
    const type = issue.fields?.issuetype?.name ?? 'Unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(total);

    // Stage time: time between first entry into each stage bucket
    const firstInGroup = statuses => statuses.map(s => firstEntryByStatus[s]).filter(Boolean).sort()[0];
    const discEntry = firstInGroup([...DISCOVERY_STATUSES].filter(s => s !== 'To Do'));
    const dsgnEntry = firstInGroup([...DESIGN_STATUSES]);
    const dlvEntry  = firstInGroup([...DELIVERY_STATUSES]);

    if (discEntry && dsgnEntry) stageTimes.discovery.push(daysBetween(discEntry, dsgnEntry));
    if (dsgnEntry && dlvEntry)  stageTimes.design.push(daysBetween(dsgnEntry, dlvEntry));
    if (dlvEntry && doneDate)   stageTimes.delivery.push(daysBetween(dlvEntry, doneDate));
  }

  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
  const med = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1);
  };

  return {
    sprint_cycle_time: { avg_days: avg(cycleTimes), median_days: med(cycleTimes), sample_size: cycleTimes.length },
    by_issue_type: Object.fromEntries(Object.entries(byType).map(([t, arr]) => [t, { avg_days: avg(arr), count: arr.length }])),
    by_stage_segment: { discovery: avg(stageTimes.discovery), design: avg(stageTimes.design), delivery: avg(stageTimes.delivery) }
  };
}

function module7_ScopeAndAge(sprint, sprintIssues) {
  const sprintStart = new Date(sprint.startDate);
  const now = new Date();

  const addedAfterStart = sprintIssues.filter(i => new Date(i.fields?.created) > sprintStart);
  const original = sprintIssues.length - addedAfterStart.length;

  const ageByStatus = {};
  const allTickets = [];

  for (const issue of sprintIssues) {
    const status = getStatus(issue);
    if (status === 'Done') continue;

    let lastStatusChange = null;
    for (const h of (issue.changelog?.histories ?? [])) {
      for (const item of (h.items ?? [])) {
        if (item.field === 'status' && item.toString === status) lastStatusChange = h.created;
      }
    }

    const enteredAt = lastStatusChange ?? issue.fields?.created;
    const days = daysBetween(enteredAt, now);
    if (!ageByStatus[status]) ageByStatus[status] = [];
    ageByStatus[status].push(days);
    allTickets.push({ key: issue.key, summary: issue.fields.summary, status, days_in_status: days, assignee: getAssignee(issue) });
  }

  allTickets.sort((a, b) => b.days_in_status - a.days_in_status);

  const avgByStatus = Object.fromEntries(
    Object.entries(ageByStatus).map(([s, arr]) => [s, +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)])
  );

  const allAges = Object.values(ageByStatus).flat();
  const avgAge = allAges.length ? +(allAges.reduce((a, b) => a + b, 0) / allAges.length).toFixed(1) : 0;

  return {
    scope_creep: {
      tickets_added_post_sprint_start: addedAfterStart.length,
      creep_rate: original > 0 ? +(addedAfterStart.length / original).toFixed(3) : 0,
      items: addedAfterStart.map(i => ({ key: i.key, summary: i.fields.summary, added_date: i.fields.created?.slice(0, 10), current_status: getStatus(i) }))
    },
    ticket_age: {
      avg_days_in_current_status: avgAge,
      by_status: avgByStatus,
      oldest_tickets: allTickets.slice(0, 3)
    }
  };
}

// --- Claude narrative ---
async function generateNarrative(data) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const prompt = `You are a product manager writing a daily sprint report for your boss. Based on the Jira data below, write a concise bullet-point summary for each of the 7 modules.

Rules:
- Maximum 3–4 bullets per module
- Be specific: use ticket keys (e.g. TAP-123), names, numbers, and percentages
- Prefix any item needing boss attention with "⚠️"
- Plain, direct language — no filler phrases like "it's worth noting"
- If data is empty or zero, summarise in 1 bullet

Data:
${JSON.stringify(data, null, 2)}

Return a JSON array (no markdown fences) — one object per module in this exact order:
[
  { "id": "sprint_progress",    "title": "Sprint Progress",           "status": "on_track|behind|warning|ok", "bullets": [...] },
  { "id": "daily_movement",     "title": "Daily Ticket Movement",     "status": "ok|warning|behind",          "bullets": [...] },
  { "id": "blockers",           "title": "Blockers & Flagged Issues", "status": "ok|warning|critical",        "bullets": [...] },
  { "id": "velocity",           "title": "Velocity (1D / 5D)",        "status": "ok|warning|behind",          "bullets": [...] },
  { "id": "assignee_velocity",  "title": "Assignee Velocity",         "status": "ok|warning",                 "bullets": [...] },
  { "id": "cycle_time",         "title": "Cycle Time",                "status": "ok|warning",                 "bullets": [...] },
  { "id": "scope_creep",        "title": "Scope Creep & Ticket Age",  "status": "ok|warning|critical",        "bullets": [...] }
]`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(text);
}

// --- Save ---
function saveReport(date, sprintMeta, modules) {
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    date,
    generated_at: new Date().toISOString(),
    sprint: {
      id: sprintMeta.sprint_id,
      name: sprintMeta.sprint_name,
      start_date: sprintMeta.start_date,
      end_date: sprintMeta.end_date,
      days_remaining: sprintMeta.days_remaining,
      on_track: sprintMeta.on_track,
      completion_rate: sprintMeta.completion_rate,
      total_issues: sprintMeta.total_issues
    },
    modules
  };

  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(report, null, 2));

  const idxPath = path.join(dir, 'index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) {
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
  }
  if (!idx.includes(date)) idx.unshift(date);
  idx.sort((a, b) => b.localeCompare(a));
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));

  console.log(`✓ Saved reports/${date}.json`);
}

// --- Main ---
async function main() {
  if (!JIRA_TOKEN)    throw new Error('JIRA_API_TOKEN is not set');
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const date = todaySGT();
  console.log(`\nGenerating report for ${date} (SGT)...\n`);

  console.log('1/8 Resolving board...');
  const boardId = await resolveBoardId();

  console.log('2/8 Getting active sprint...');
  const sprint = await getActiveSprint(boardId);
  if (!sprint) { console.warn('No active sprint — skipping.'); return; }
  console.log(`  Sprint: ${sprint.name}`);

  console.log('3/8 Fetching sprint issues...');
  const sprintIssues = await getSprintIssues(sprint.id);
  console.log(`  ${sprintIssues.length} issues`);

  console.log('4/8 Fetching today\'s updates...');
  const todayIssues = await getUpdatedTodayIssues();

  console.log('5/8 Fetching blockers...');
  const blockerIssues = await getBlockerIssues();

  console.log('6/8 Fetching velocity windows...');
  const [vel1d, vel5d] = await Promise.all([getVelocityIssues(1), getVelocityIssues(5)]);

  console.log('7/8 Processing modules...');
  const rawData = {
    sprint_progress:   module1_SprintProgress(sprint, sprintIssues),
    daily_movement:    module2_DailyMovement(todayIssues),
    blockers:          module3_Blockers(blockerIssues, sprintIssues),
    velocity:          module4_Velocity(vel1d, vel5d),
    assignee_velocity: module5_AssigneeVelocity(sprintIssues, vel1d, vel5d),
    cycle_time:        module6_CycleTime(sprintIssues),
    scope_creep:       module7_ScopeAndAge(sprint, sprintIssues)
  };

  console.log('8/8 Generating narrative with Claude...');
  const modules = await generateNarrative(rawData);

  saveReport(date, rawData.sprint_progress, modules);
  console.log('\nDone!\n');
}

main().catch(err => { console.error('\n✗ Error:', err.message); process.exit(1); });
