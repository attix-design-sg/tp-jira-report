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

async function jiraPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira ${res.status} ${url}\n${text}`);
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

async function jiraSearchAll(jql, fields, expand = []) {
  const all = [];
  const baseUrl = `${JIRA_BASE}/rest/api/3/search/jql${expand.length ? '?expand=' + expand.join(',') : ''}`;
  let nextPageToken = undefined;
  while (true) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraPost(baseUrl, body);
    const items = data.issues ?? [];
    all.push(...items);
    if (!data.nextPageToken || items.length < 100) break;
    nextPageToken = data.nextPageToken;
  }
  return all;
}

// --- Date helpers ---
function todaySGT() {
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

function getEpic(issue) {
  const parent = issue.fields?.parent;
  if (parent?.fields?.issuetype?.name === 'Epic') {
    return { key: parent.key, name: parent.fields.summary };
  }
  return null;
}

// --- Jira API calls ---
async function getBoardIssues(boardId) {
  return jiraFetchAll(
    `${JIRA_BASE}/rest/agile/1.0/board/${boardId}/issue?expand=changelog&fields=summary,status,assignee,issuetype,priority,created,parent`,
    'issues'
  );
}

async function getUpdatedTodayIssues() {
  const today = todaySGT();
  const jql = `project = ${PROJECT_KEY} AND updated >= "${today}" ORDER BY updated DESC`;
  return jiraSearchAll(jql, ['summary','status','assignee','issuetype','priority','created','parent'], ['changelog']);
}

async function getBlockerIssues() {
  const jql = `project = ${PROJECT_KEY} AND statusCategory != Done AND (flagged = Impediment OR status = "Blocked")`;
  return jiraSearchAll(jql, ['summary','assignee','status','priority','updated','comment']);
}

async function getVelocityIssues(days) {
  const jql = `project = ${PROJECT_KEY} AND status changed AFTER "-${days}d" AND NOT status changed TO "To Do"`;
  return jiraSearchAll(jql, ['summary','status','assignee'], ['changelog']);
}

// --- Module processors ---
function module1_BoardProgress(issues) {
  const breakdown = Object.fromEntries(WORKFLOW.map(s => [s, 0]));
  for (const issue of issues) {
    const s = getStatus(issue);
    breakdown[s] = (breakdown[s] ?? 0) + 1;
  }

  const total = issues.length;
  const done = breakdown['Done'] ?? 0;
  const open = total - done;
  const completionRate = total > 0 ? done / total : 0;

  const inDiscovery = [...DISCOVERY_STATUSES].reduce((n, s) => n + (breakdown[s] ?? 0), 0);
  const inDesign    = [...DESIGN_STATUSES].reduce((n, s)    => n + (breakdown[s] ?? 0), 0);
  const inDelivery  = [...DELIVERY_STATUSES].reduce((n, s)  => n + (breakdown[s] ?? 0), 0);

  // Group by epic
  const epicMap = {};
  for (const issue of issues) {
    const epic = getEpic(issue);
    const epicKey = epic ? epic.key : '__no_epic__';
    const epicName = epic ? `${epic.key} ${epic.name}` : 'No Epic';
    if (!epicMap[epicKey]) epicMap[epicKey] = { epic: epicName, total: 0, done: 0, in_progress: 0, status_breakdown: {} };
    const e = epicMap[epicKey];
    const status = getStatus(issue);
    e.total++;
    if (status === 'Done') e.done++;
    else if (status !== 'To Do') e.in_progress++;
    e.status_breakdown[status] = (e.status_breakdown[status] ?? 0) + 1;
  }
  const by_epic = Object.values(epicMap).sort((a, b) => b.in_progress - a.in_progress);

  return {
    total_issues: total,
    open_issues: open,
    done_issues: done,
    completion_rate: +completionRate.toFixed(3),
    stage_summary: { discovery: inDiscovery, design: inDesign, delivery: inDelivery, done },
    by_epic
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
        const epic = getEpic(issue);
        const entry = { key: issue.key, summary: issue.fields.summary, epic: epic ? `${epic.key} ${epic.name}` : null, assignee: getAssignee(issue), from_status: item.fromString, to_status: item.toString, at: history.created };
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

function module3_Blockers(blockerIssues, boardIssues) {
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
  for (const issue of boardIssues) {
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

function module5_AssigneeVelocity(boardIssues, issues1d, issues5d) {
  const map = {};

  for (const issue of boardIssues) {
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


function module6_TicketAge(boardIssues) {
  const now = new Date();
  const ageByStatus = {};
  const allTickets = [];

  for (const issue of boardIssues) {
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
    avg_days_in_current_status: avgAge,
    by_status: avgByStatus,
    oldest_tickets: allTickets.slice(0, 5)
  };
}

// --- Claude narrative ---
async function generateNarrative(data) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const prompt = `You are a product manager writing a daily board report for your boss. Based on the Jira data below, write a concise bullet-point summary for each of the 6 modules.

Rules:
- Maximum 3–4 bullets per module
- Be specific: use ticket keys (e.g. TP-123), names, numbers, and percentages
- Prefix any item needing boss attention with "⚠️"
- Plain, direct language — no filler phrases like "it's worth noting"
- Report facts only — no recommendations, insights, predictions, or actionable suggestions
- If data is empty or zero, summarise in 1 bullet
- For Board Progress: if any epics have tickets in progress or done, list each epic by name with its done/total count (e.g. "TP-5 Epic Name: 2/4 done, 1 in progress"). If no movement at all, one bullet is fine.
- For Daily Ticket Movement: if any tickets moved, group them by epic. For each epic, list each ticket that moved with its key, name, and status transition (e.g. "TP-5 Epic Name → [TP-12] Ticket name: Design → Dev"). If no movement, one bullet is fine.

Data:
${JSON.stringify(data, null, 2)}

Return a JSON array (no markdown fences) — one object per module in this exact order:
[
  { "id": "board_progress",     "title": "Board Progress",            "status": "ok|warning|behind",   "bullets": [...] },
  { "id": "daily_movement",     "title": "Daily Ticket Movement",     "status": "ok|warning|behind",   "bullets": [...] },
  { "id": "blockers",           "title": "Blockers & Flagged Issues", "status": "ok|warning|critical", "bullets": [...] },
  { "id": "velocity",           "title": "Velocity (1D / 5D)",        "status": "ok|warning|behind",   "bullets": [...] },
  { "id": "assignee_velocity",  "title": "Assignee Velocity",         "status": "ok|warning",          "bullets": [...] },
  { "id": "ticket_age",         "title": "Ticket Age",                "status": "ok|warning|critical", "bullets": [...] }
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
function saveReport(date, boardMeta, modules) {
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    date,
    generated_at: new Date().toISOString(),
    board: {
      id: BOARD_ID,
      name: 'TP board',
      total_issues: boardMeta.total_issues,
      open_issues: boardMeta.open_issues,
      done_issues: boardMeta.done_issues,
      completion_rate: boardMeta.completion_rate,
      stage_summary: boardMeta.stage_summary
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

  console.log('1/6 Fetching board issues...');
  const boardIssues = await getBoardIssues(BOARD_ID);
  console.log(`  ${boardIssues.length} issues`);

  console.log('2/6 Fetching today\'s updates...');
  const todayIssues = await getUpdatedTodayIssues();
  console.log(`  ${todayIssues.length} issues updated today`);

  console.log('3/6 Fetching blockers...');
  const blockerIssues = await getBlockerIssues();
  console.log(`  ${blockerIssues.length} blockers`);

  console.log('4/6 Fetching velocity windows...');
  const [vel1d, vel5d] = await Promise.all([getVelocityIssues(1), getVelocityIssues(5)]);
  console.log(`  1d: ${vel1d.length}, 5d: ${vel5d.length}`);

  console.log('5/6 Processing modules...');
  const rawData = {
    board_progress:    module1_BoardProgress(boardIssues),
    daily_movement:    module2_DailyMovement(todayIssues),
    blockers:          module3_Blockers(blockerIssues, boardIssues),
    velocity:          module4_Velocity(vel1d, vel5d),
    assignee_velocity: module5_AssigneeVelocity(boardIssues, vel1d, vel5d),
    ticket_age:        module6_TicketAge(boardIssues)
  };

  console.log('6/6 Generating narrative with Claude...');
  const modules = await generateNarrative(rawData);

  saveReport(date, rawData.board_progress, modules);
  console.log('\nDone!\n');
}

main().catch(err => { console.error('\n✗ Error:', err.message); process.exit(1); });
