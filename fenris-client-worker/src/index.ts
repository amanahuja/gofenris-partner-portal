import { marked } from 'marked';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  CLIENT_CODES: KVNamespace;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
}

interface ClientRecord {
  label: string;
  github_folder: string;
}

interface TeamMember {
  name: string;
  role: string;
}

interface Frontmatter {
  type?: string;
  timeline?: string;
  funder_chain?: string;
  summary?: string;
  team?: TeamMember[];
}

interface GitHubFile {
  name: string;
  path: string;
  type: string;
  content?: string;
  encoding?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }

  const closeIndex = content.indexOf('\n---', 4);
  if (closeIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmRaw = content.slice(4, closeIndex);
  const body = content.slice(closeIndex + 4).replace(/^\n/, '');

  const frontmatter: Frontmatter = {};
  const lines = fmRaw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('type:')) {
      frontmatter.type = line.slice(5).trim();
    } else if (line.startsWith('timeline:')) {
      frontmatter.timeline = line.slice(9).trim();
    } else if (line.startsWith('funder_chain:')) {
      frontmatter.funder_chain = line.slice(13).trim();
    } else if (line.startsWith('summary:')) {
      frontmatter.summary = line.slice(8).trim();
    } else if (line.startsWith('team:')) {
      frontmatter.team = [];
      i++;
      while (i < lines.length && lines[i].startsWith('  ')) {
        const nameLine = lines[i].trim();
        if (nameLine.startsWith('- name:')) {
          const member: TeamMember = { name: nameLine.slice(7).trim(), role: '' };
          i++;
          if (i < lines.length && lines[i].trim().startsWith('role:')) {
            member.role = lines[i].trim().slice(5).trim();
          }
          frontmatter.team.push(member);
        }
        i++;
      }
      continue;
    }
    i++;
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchGitHubDirectory(folder: string, env: Env): Promise<GitHubFile[]> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${folder}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'fenris-client-worker',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub directory fetch failed: ${res.status} ${res.statusText}`);
  }

  const files: GitHubFile[] = await res.json();
  return files
    .filter((f) => f.type === 'file' && f.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchGitHubFile(path: string, env: Env): Promise<string> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'fenris-client-worker',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub file fetch failed: ${path} — ${res.status} ${res.statusText}`);
  }

  const file: GitHubFile = await res.json();
  if (!file.content) return '';

  // GitHub returns base64 with newlines; decode as UTF-8 to handle multi-byte characters
  const cleaned = file.content.replace(/\n/g, '');
  const bytes = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// Extract first H1 and H2 from markdown source
// ---------------------------------------------------------------------------

function extractH1(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractH2(markdown: string): string {
  const match = markdown.match(/^##\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Status badge renderer
// ---------------------------------------------------------------------------

// Blue = active/in-flight, Amber = attention/blocked, Green = done, Grey = not started/unknown
const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  'active-on-track':        { bg: '#dbeafe', color: '#1e40af' },  // blue
  'in-progress':            { bg: '#dbeafe', color: '#1e40af' },  // blue
  'active-needs-attention': { bg: '#fef9c3', color: '#854d0e' },  // amber
  'paused':                 { bg: '#fef9c3', color: '#854d0e' },  // amber
  'delivered':              { bg: '#dcfce7', color: '#166534' },  // green
  'complete':               { bg: '#dcfce7', color: '#166534' },  // green
  'upcoming':               { bg: '#f1f5f9', color: '#475569' },  // grey
};

function badgeSlug(value: string): string {
  return value.toLowerCase().replace(/·/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function renderBadge(value: string): string {
  const slug = badgeSlug(value);
  const style = BADGE_STYLES[slug] || { bg: '#f1f5f9', color: '#475569' };
  return `<span class="badge" style="background:${style.bg};color:${style.color}">${value}</span>`;
}

// Known status values for table cell badge replacement
const STATUS_VALUES = [
  'Active · On track',
  'Active · Needs attention',
  'Paused',
  'Complete',
  'Upcoming',
  'In progress',
  'Delivered',
];

// Replace **Status:** lines in rendered HTML with badge elements
// Also replaces known status values appearing as plain text in table cells
function applyStatusBadges(html: string): string {
  // Matches: <p><strong>Status:</strong> value</p>
  let result = html.replace(
    /<p><strong>Status:<\/strong>\s*([^<]+)<\/p>/g,
    (_match, value) => `<p class="status-line">${renderBadge(value.trim())}</p>`
  );

  // Replace status values in table cells — only in columns headed "Status"
  result = result.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    // Find the index of the Status column from the header row
    const theadMatch = table.match(/<thead>([\s\S]*?)<\/thead>/);
    if (!theadMatch) return table;
    const headers = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => m[1].trim());
    const statusCol = headers.findIndex(h => h.toLowerCase() === 'status');
    if (statusCol === -1) return table;

    // Badge the cell at statusCol in every body row
    return table.replace(/<tr>([\s\S]*?)<\/tr>/g, (row, inner) => {
      const cellMatches = [...inner.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
      if (cellMatches.length <= statusCol) return row;
      const cell = cellMatches[statusCol];
      const attrs = cell[1];
      const content = cell[2].trim();
      // Strip <strong> wrapping (bolded current-phase rows) to get plain value
      const plainValue = content.replace(/^<strong>([\s\S]*?)<\/strong>$/, '$1').trim();
      // Only replace if not already a badge
      if (!plainValue.includes('<') && plainValue.length > 0) {
        return row.replace(
          `<td${attrs}>${cell[2]}</td>`,
          `<td${attrs}>${renderBadge(plainValue)}</td>`
        );
      }
      return row;
    });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Project metadata fields renderer
// Converts **Field:** value lines (rendered as <p> or <br>-separated lines)
// into labelled meta rows, with Status rendered as a badge
// ---------------------------------------------------------------------------

const PROJECT_META_FIELDS = ['Status', 'End client', 'Period', 'Budget'];

function applyProjectMeta(html: string): string {
  // marked renders trailing-space line breaks as <br> within a single <p>
  // e.g. <p><strong>Status:</strong> Active · On track<br>\n<strong>End client:</strong> ...
  // Split those into individual lines first, then process each

  // Step 1: replace <br> inside project meta paragraphs with a sentinel
  // We process each <p> that starts with a known meta field
  html = html.replace(
    /<p>(<strong>(?:Status|End client|Period|Budget):[\s\S]*?)<\/p>/g,
    (_match, inner) => {
      // Split on <br> boundaries
      const lines = inner.split(/<br\s*\/?>\n?/);
      return lines.map((line: string) => `<p>${line.trim()}</p>`).join('\n');
    }
  );

  // Step 2: convert Status lines to badge rows
  html = html.replace(
    /<p><strong>Status:<\/strong>\s*([^<]+)<\/p>/g,
    (_match, value) =>
      `<div class="project-meta-row"><span class="meta-label">Status</span><span class="meta-value">${renderBadge(value.trim())}</span></div>`
  );

  // Step 3: convert other meta fields to labelled rows
  for (const field of ['End client', 'Period', 'Budget']) {
    const re = new RegExp(`<p><strong>${field}:<\\/strong>\\s*([^<]+)<\\/p>`, 'g');
    html = html.replace(
      re,
      (_match, value) =>
        `<div class="project-meta-row"><span class="meta-label">${field}</span><span class="meta-value">${value.trim()}</span></div>`
    );
  }

  return html;
}

// ---------------------------------------------------------------------------
// Workstream card wrapper
// Wraps each <h3>...</h3> + content up to next <h3> or end in a card div
// ---------------------------------------------------------------------------

function applyWorkstreamCards(html: string): string {
  const hrIndex = html.indexOf('<hr>');
  const activePart = hrIndex !== -1 ? html.slice(0, hrIndex) : html;
  const mutedPart = hrIndex !== -1 ? html.slice(hrIndex + 4) : '';

  function wrapWorkstreams(source: string, muted: boolean): string {
    const parts = source.split(/(?=<h3[^>]*>)/);
    return parts
      .map((part) => {
        if (!part.startsWith('<h3')) return part;
        const cls = muted ? 'workstream-card muted' : 'workstream-card';
        return `<div class="${cls}">${part}</div>`;
      })
      .join('');
  }

  return wrapWorkstreams(activePart, false) + (mutedPart ? wrapWorkstreams(mutedPart, true) : '');
}

// ---------------------------------------------------------------------------
// Project card wrapper (similar to workstream but includes muting at <hr>)
// ---------------------------------------------------------------------------

function applyProjectCards(html: string): string {
  // Split into active and muted sections at <hr>
  const hrIndex = html.indexOf('<hr>');
  let activePart = hrIndex !== -1 ? html.slice(0, hrIndex) : html;
  let mutedPart = hrIndex !== -1 ? html.slice(hrIndex + 4) : '';

  function wrapProjects(source: string, muted: boolean): string {
    const parts = source.split(/(?=<h3[^>]*>)/);
    return parts
      .map((part) => {
        if (!part.startsWith('<h3')) return part;
        const cls = muted ? 'project-card muted' : 'project-card';
        return `<div class="${cls}">${part}</div>`;
      })
      .join('');
  }

  return wrapProjects(activePart, false) + (mutedPart ? wrapProjects(mutedPart, true) : '');
}

// ---------------------------------------------------------------------------
// Phase table: highlight current row (bolded row)
// ---------------------------------------------------------------------------

function applyPhaseTableHighlight(html: string): string {
  // A current-phase row has <td><strong> in it
  return html.replace(
    /<tr>(\s*<td><strong>.*?<\/strong><\/td>.*?)<\/tr>/gs,
    '<tr class="current-phase">$1</tr>'
  );
}

// ---------------------------------------------------------------------------
// Wrap tables in scrollable container
// ---------------------------------------------------------------------------

function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>');
}

// ---------------------------------------------------------------------------
// Updates timeline post-processor
// Converts paragraphs matching <p><strong>YYYY-MM-DD</strong> — text</p>
// into a <ul class="updates-list"> timeline
// ---------------------------------------------------------------------------

function applyUpdatesTimeline(html: string): string {
  const itemRe = /<p><strong>(\d{4}-\d{2}-\d{2})<\/strong>\s*[–—]\s*(.+?)<\/p>/gs;
  const items: string[] = [];
  let match;

  // Collect all matching paragraphs
  while ((match = itemRe.exec(html)) !== null) {
    const [, date, text] = match;
    items.push(
      `<li class="update-item"><span class="update-date">${date}</span><span class="update-text">${text.trim()}</span></li>`
    );
  }

  if (items.length === 0) return html;

  // Replace the entire block of matching paragraphs with the timeline list
  const listHtml = `<ul class="updates-list">${items.join('')}</ul>`;
  return html.replace(/<p><strong>\d{4}-\d{2}-\d{2}<\/strong>[\s\S]*?(?=<p><strong>\d{4}|$)/g, '').trimEnd()
    + '\n' + listHtml;
}

// Cleaner approach: replace all update paragraphs in one pass
function buildUpdatesTimeline(html: string): string {
  const itemRe = /<p><strong>(\d{4}-\d{2}-\d{2})<\/strong>\s*(?:–|—|-{1,2})\s*([\s\S]*?)<\/p>/g;
  const items: Array<{ full: string; date: string; text: string }> = [];
  let match;

  while ((match = itemRe.exec(html)) !== null) {
    items.push({ full: match[0], date: match[1], text: match[2].trim() });
  }

  if (items.length === 0) return html;

  // Remove all the individual paragraphs and replace with the list
  let result = html;
  for (const item of items) {
    result = result.replace(item.full, '');
  }

  const listItems = items.map(
    (item) =>
      `<li class="update-item"><span class="update-date">${item.date}</span><span class="update-text">${item.text}</span></li>`
  );
  result += `\n<ul class="updates-list">${listItems.join('')}</ul>`;
  return result;
}

// ---------------------------------------------------------------------------
// Overview card HTML builder
// ---------------------------------------------------------------------------

function buildOverviewCard(fm: Frontmatter): string {
  const metaRows: string[] = [];

  if (fm.type) {
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Type</span>
        <span class="meta-value">${fm.type}</span>
      </div>`);
  }

  if (fm.timeline) {
    metaRows.push(`
      <div class="meta-row">
        <span class="meta-label">Timeline</span>
        <span class="meta-value">${fm.timeline}</span>
      </div>`);
  }

  const funderPanel = fm.funder_chain
    ? `<div class="overview-funder-panel">
        <span class="meta-label">Stakeholder Map</span>
        <div class="funder-chain">${fm.funder_chain}</div>
      </div>`
    : '';

  const teamRows = (fm.team || [])
    .map(
      (m) => `<tr>
        <td class="team-name">${m.name}</td>
        <td class="team-role">${m.role}</td>
      </tr>`
    )
    .join('');

  const teamPanel = fm.team && fm.team.length > 0
    ? `<div class="overview-team-panel">
        <span class="meta-label">Fenris Project Team</span>
        <table class="team-table">
          <tbody>${teamRows}</tbody>
        </table>
      </div>`
    : '';

  return `
  <div class="overview-card">
    <div class="overview-meta-row">
      <div class="overview-meta-panel">${metaRows.join('')}</div>
      ${funderPanel}
    </div>
    ${teamPanel}
  </div>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function getStyles(): string {
  return `
    :root {
      --color-primary:   #1A4C70;
      --color-secondary: #4A4A4A;
      --color-tertiary:  #5B8DB8;
      --color-neutral:   #F0F0F0;
      --color-mid-grey:  #777777;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Manrope', sans-serif;
      font-size: 1rem;
      font-weight: 500;
      line-height: 1.625;
      color: var(--color-secondary);
      background: #fff;
    }

    /* ---- Nav ---- */
    .site-nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #fff;
      border-bottom: 1px solid var(--color-neutral);
      display: flex;
      align-items: center;
      padding: 0 1.5rem;
      height: 3.5rem;
    }
    .site-nav .wordmark {
      font-weight: 700;
      font-size: 1.25rem;
      letter-spacing: -0.05em;
      color: var(--color-primary);
      text-decoration: none;
      flex-shrink: 0;
    }
    .site-nav .nav-links {
      display: flex;
      gap: 1.5rem;
      margin: 0 auto;
      list-style: none;
      padding: 0;
      flex-wrap: wrap;
    }
    .site-nav .nav-links a {
      font-weight: 700;
      font-size: 0.9rem;
      letter-spacing: -0.01em;
      color: var(--color-secondary);
      text-decoration: none;
      padding-bottom: 2px;
      white-space: nowrap;
    }
    .site-nav .nav-links a.active {
      color: var(--color-primary);
      border-bottom: 2px solid var(--color-primary);
    }

    /* ---- Page layout ---- */
    .page-container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 4rem;
    }

    /* ---- Page header ---- */
    .client-label {
      display: inline-block;
      background: var(--color-primary);
      color: #fff;
      font-weight: 700;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      border-radius: 9999px;
      padding: 0.2rem 0.65rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-weight: 800;
      font-size: 3rem;
      letter-spacing: -0.025em;
      line-height: 1.25;
      color: var(--color-secondary);
      margin-bottom: 0.75rem;
    }
    .summary {
      font-weight: 500;
      font-size: 1.125rem;
      line-height: 1.625;
      color: #64748b;
      margin-bottom: 2rem;
    }

    /* ---- Overview card ---- */
    .overview-card {
      border: 1px solid var(--color-neutral);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      background: #fff;
    }
    .overview-meta-row {
      display: flex;
      gap: 2rem;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }
    .overview-meta-panel {
      flex: 1;
      min-width: 160px;
    }
    .overview-funder-panel {
      flex: 1;
      min-width: 160px;
    }
    .meta-row {
      margin-bottom: 0.75rem;
    }
    .meta-label {
      display: block;
      font-weight: 700;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--color-mid-grey);
      margin-bottom: 0.2rem;
    }
    .meta-value {
      font-weight: 700;
      font-size: 1rem;
      color: var(--color-secondary);
    }
    .funder-chain {
      font-weight: 700;
      font-size: 1rem;
      color: var(--color-secondary);
      margin-top: 0.2rem;
    }
    .overview-team-panel {
      border-top: 1px solid var(--color-neutral);
      padding-top: 1rem;
    }
    .overview-team-panel > .meta-label {
      margin-bottom: 0.75rem;
    }
    .team-table {
      width: 100%;
      border-collapse: collapse;
    }
    .team-table td {
      padding: 0.4rem 0;
      font-size: 0.9rem;
    }
    .team-name {
      font-weight: 700;
      color: var(--color-primary);
      width: 50%;
    }
    .team-role {
      font-weight: 500;
      color: var(--color-mid-grey);
      text-align: right;
    }

    /* ---- Sections ---- */
    section {
      margin-top: 3rem;
    }
    h2 {
      font-weight: 700;
      font-size: 1.5rem;
      letter-spacing: -0.025em;
      color: var(--color-primary);
      margin-bottom: 1.25rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--color-neutral);
    }
    h3 {
      font-weight: 700;
      font-size: 1rem;
      color: var(--color-secondary);
      margin-bottom: 0.5rem;
    }
    p {
      margin-bottom: 1rem;
      font-weight: 500;
      font-size: 1rem;
      line-height: 1.625;
    }
    ul, ol {
      margin-bottom: 1rem;
      padding-left: 1.5rem;
    }
    li {
      margin-bottom: 0.25rem;
    }
    strong { font-weight: 700; }

    /* ---- Tables ---- */
    .table-scroll {
      overflow-x: auto;
      margin-bottom: 1.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    thead th {
      font-weight: 700;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--color-mid-grey);
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--color-neutral);
    }
    tbody td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--color-neutral);
      vertical-align: top;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    tbody tr:hover {
      background: #fafafa;
    }
    tr.current-phase {
      background: #eff6ff;
      border-left: 3px solid var(--color-primary);
    }
    tr.current-phase td {
      font-weight: 700;
    }

    /* ---- Status badges ---- */
    .badge {
      display: inline-block;
      font-weight: 700;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 9999px;
      padding: 0.2rem 0.6rem;
      white-space: nowrap;
    }
    .status-line {
      margin-bottom: 0.75rem;
    }

    /* ---- Workstream cards ---- */
    .workstream-card {
      border-left: 3px solid var(--color-primary);
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      background: #fff;
      border-radius: 0 4px 4px 0;
      border-top: 1px solid var(--color-neutral);
      border-right: 1px solid var(--color-neutral);
      border-bottom: 1px solid var(--color-neutral);
    }
    .workstream-card h3 {
      margin-bottom: 0.4rem;
    }
    .workstream-card p {
      font-size: 0.875rem;
      color: #64748b;
      margin-bottom: 0;
    }

    /* ---- Project cards ---- */
    .project-card {
      border: 1px solid var(--color-neutral);
      border-radius: 6px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      background: #fff;
    }
    .project-card h3 {
      margin-bottom: 0.5rem;
    }
    .project-card p {
      font-size: 0.875rem;
      color: #64748b;
      margin-bottom: 0;
    }
    .project-meta-row {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      margin-bottom: 0.4rem;
    }
    .project-meta-row .meta-label {
      display: inline;
      min-width: 80px;
    }
    .project-meta-row .meta-value {
      font-size: 0.875rem;
      font-weight: 700;
    }

    /* ---- Muted / completed items ---- */
    .muted {
      opacity: 0.55;
    }

    /* ---- Updates timeline ---- */
    .updates-list {
      list-style: none;
      padding: 0;
      border-left: 2px solid var(--color-neutral);
      margin-left: 0.5rem;
    }
    .update-item {
      position: relative;
      padding: 0 0 1.5rem 1.5rem;
    }
    .update-item::before {
      content: '';
      position: absolute;
      left: -0.45rem;
      top: 0.35rem;
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 50%;
      background: var(--color-primary);
    }
    .update-date {
      display: block;
      font-weight: 700;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--color-mid-grey);
      margin-bottom: 0.2rem;
    }
    .update-text {
      font-size: 0.9rem;
      line-height: 1.5;
    }

    /* ---- Footer ---- */
    .site-footer {
      margin-top: 4rem;
      border-top: 1px solid var(--color-neutral);
      padding: 1.5rem;
      text-align: center;
      color: var(--color-mid-grey);
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .site-footer a {
      color: var(--color-mid-grey);
      text-decoration: none;
      margin: 0 0.75rem;
    }
    .site-footer a:hover {
      color: var(--color-primary);
    }

    /* ---- Code entry form ---- */
    .entry-page {
      min-height: 100vh;
      background: var(--color-neutral);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .entry-card {
      max-width: 360px;
      width: 100%;
      background: #fff;
      border-radius: 10px;
      padding: 2.5rem 2rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      text-align: center;
    }
    .entry-card img {
      width: 120px;
      margin-bottom: 1.75rem;
    }
    .entry-card .client-label {
      margin-bottom: 1.25rem;
    }
    .entry-card label {
      display: block;
      font-weight: 700;
      font-size: 0.875rem;
      color: var(--color-secondary);
      margin-bottom: 0.75rem;
    }
    .entry-card input[type="text"] {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 1rem;
      font-family: 'Manrope', sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.75rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .entry-card input[type="text"]:focus {
      border-color: var(--color-primary);
    }
    .entry-card button {
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--color-primary);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-weight: 700;
      font-size: 1rem;
      font-family: 'Manrope', sans-serif;
      cursor: pointer;
      transition: background 0.15s;
    }
    .entry-card button:hover {
      background: #153d5a;
    }
    .entry-error {
      color: #b91c1c;
      font-size: 0.875rem;
      margin-top: 0.5rem;
      text-align: left;
    }

    /* ---- Mobile ---- */
    @media (max-width: 600px) {
      h1 { font-size: 2rem; }
      .site-nav { padding: 0 1rem; }
      .site-nav .nav-links {
        flex-wrap: nowrap;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        gap: 1.1rem;
        font-size: 0.8rem;
        scrollbar-width: none;
      }
      .site-nav .nav-links::-webkit-scrollbar { display: none; }
      .site-nav .wordmark { display: none; }
      .page-container { padding: 1.5rem 1rem 3rem; }
      .overview-meta-row { flex-direction: column; gap: 1rem; }
    }
  `;
}

// ---------------------------------------------------------------------------
// IntersectionObserver script for active nav link
// ---------------------------------------------------------------------------

function getNavScript(): string {
  return `
    (function() {
      const sections = document.querySelectorAll('section[id]');
      const navLinks = document.querySelectorAll('.nav-links a');
      if (!sections.length || !navLinks.length) return;
      const obs = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            navLinks.forEach(function(a) { a.classList.remove('active'); });
            const link = document.querySelector('.nav-links a[href="#' + entry.target.id + '"]');
            if (link) {
              link.classList.add('active');
              link.scrollIntoView({ inline: 'nearest', block: 'nearest' });
            }
          }
        });
      }, { rootMargin: '-20% 0px -70% 0px' });
      sections.forEach(function(s) { obs.observe(s); });
    })();
  `;
}

// ---------------------------------------------------------------------------
// Google Fonts link
// ---------------------------------------------------------------------------

function getFontsLink(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;
}

// ---------------------------------------------------------------------------
// Code entry form HTML
// ---------------------------------------------------------------------------

function renderEntryForm(error = false): string {
  const errorHtml = error
    ? `<p class="entry-error">Code not recognised. Please check and try again.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fenris Partner Portal</title>
  ${getFontsLink()}
  <style>${getStyles()}</style>
</head>
<body>
  <div class="entry-page">
    <div class="entry-card">
      <img src="https://raw.githubusercontent.com/gofenris/gofenris.github.io/main/static/images/fenris/fenris_logo_2ct_nb.png" alt="Fenris">
      <span class="client-label">Fenris Secure Partner Portal</span>
      <form method="POST" action="/">
        <label for="code">Enter your partner code</label>
        <input type="text" id="code" name="code" placeholder="ABCD1234" autocomplete="off" autocapitalize="characters" spellcheck="false">
        ${errorHtml}
        <button type="submit">View your engagement</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Determine section type for post-processing
// ---------------------------------------------------------------------------

type SectionType = 'overview' | 'phases' | 'workstreams' | 'projects' | 'updates' | 'deliverables' | 'generic';

function inferSectionType(h2Label: string, filename: string): SectionType {
  const label = h2Label.toLowerCase();
  const file = filename.toLowerCase();

  if (file.startsWith('01')) return 'overview';
  if (label.includes('phase') || label.includes('work order')) return 'phases';
  if (label.includes('workstream')) return 'workstreams';
  if (label.includes('project')) return 'projects';
  if (label.includes('update') || label.includes('event') || label.includes('log')) return 'updates';
  if (label.includes('deliverable')) return 'deliverables';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Post-process rendered HTML per section type
// ---------------------------------------------------------------------------

function postProcess(html: string, type: SectionType): string {
  // Always apply badge replacement
  html = applyStatusBadges(html);
  // Always wrap tables
  html = wrapTables(html);

  switch (type) {
    case 'workstreams':
      html = applyWorkstreamCards(html);
      break;
    case 'projects':
      html = applyProjectMeta(html);
      html = applyProjectCards(html);
      break;
    case 'phases':
      html = applyPhaseTableHighlight(html);
      break;
    case 'updates':
      html = buildUpdatesTimeline(html);
      break;
    case 'deliverables':
      // tables already wrapped, badges already applied
      break;
    default:
      break;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Full client page HTML assembler
// ---------------------------------------------------------------------------

async function renderClientPage(files: GitHubFile[], env: Env): Promise<string> {
  // Configure marked for GFM (tables etc.)
  marked.use({ gfm: true });

  let pageTitle = '';
  let summary = '';
  let overviewCardHtml = '';
  let navLinks: Array<{ label: string; slug: string }> = [];
  const sections: Array<{ slug: string; html: string }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const raw = await fetchGitHubFile(file.path, env);

    if (i === 0) {
      // First file: parse frontmatter, extract H1, build overview card
      const { frontmatter, body } = parseFrontmatter(raw);

      pageTitle = extractH1(body);
      summary = frontmatter.summary || '';
      overviewCardHtml = buildOverviewCard(frontmatter);

      // Remove the H1 line from body before rendering
      const bodyWithoutH1 = body.replace(/^#\s+.+\n?/m, '').trim();

      const h2Label = extractH2(bodyWithoutH1);
      const slug = slugify(h2Label || 'overview');
      navLinks.push({ label: h2Label || 'Overview', slug });

      const rendered = await marked.parse(bodyWithoutH1);
      // Strip the first <h2> from rendered output — we render it explicitly in the section wrapper
      const renderedWithoutH2 = rendered.replace(/^<h2>[^<]*<\/h2>\n?/i, '');
      const processed = postProcess(renderedWithoutH2, 'overview');

      sections.push({
        slug,
        html: `<h2>${h2Label}</h2>\n${overviewCardHtml}\n${processed}`,
      });
    } else {
      // Section files: extract H2 for nav, render body, post-process
      const h2Label = extractH2(raw);
      const slug = slugify(h2Label || `section-${i + 1}`);
      navLinks.push({ label: h2Label || `Section ${i + 1}`, slug });

      const sectionType = inferSectionType(h2Label, file.name);
      const rendered = await marked.parse(raw);
      const processed = postProcess(rendered, sectionType);

      sections.push({ slug, html: processed });
    }
  }

  // Build nav links HTML
  const navLinksHtml = navLinks
    .map((n) => `<li><a href="#${n.slug}">${n.label}</a></li>`)
    .join('\n        ');

  // Build sections HTML
  const sectionsHtml = sections
    .map((s) => `<section id="${s.slug}">\n${s.html}\n</section>`)
    .join('\n\n');

  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle} — Fenris</title>
  ${getFontsLink()}
  <style>${getStyles()}</style>
</head>
<body>
  <nav class="site-nav">
    <a href="https://gofenris.com" class="wordmark">Fenris</a>
    <ul class="nav-links">
        ${navLinksHtml}
    </ul>
  </nav>

  <div class="page-container">
    <span class="client-label">Fenris Secure Partner Portal</span>
    <h1>${pageTitle}</h1>
    ${summary ? `<p class="summary">${summary}</p>` : ''}

    ${sectionsHtml}
  </div>

  <footer class="site-footer">
    <span>© ${year} Fenris</span>
    <a href="https://gofenris.com/privacy-policy/">Privacy Policy</a>
    <a href="https://gofenris.com/#contact">Contact</a>
  </footer>

  <script>${getNavScript()}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let code: string | null = null;

    if (request.method === 'POST') {
      try {
        const formData = await request.formData();
        code = (formData.get('code') as string | null)?.trim().toUpperCase() ?? null;
      } catch {
        code = null;
      }
    } else {
      code = url.searchParams.get('code')?.trim().toUpperCase() ?? null;
    }

    // No code submitted — show entry form
    if (!code) {
      return new Response(renderEntryForm(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Look up code in KV
    let record: string | null = null;
    try {
      record = await env.CLIENT_CODES.get(code);
    } catch {
      return new Response(renderEntryForm(true), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (!record) {
      return new Response(renderEntryForm(true), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    let client: ClientRecord;
    try {
      client = JSON.parse(record) as ClientRecord;
    } catch {
      return new Response(renderEntryForm(true), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Fetch and render client content
    try {
      const files = await fetchGitHubDirectory(client.github_folder, env);

      if (files.length === 0) {
        return new Response('No content found for this client.', { status: 404 });
      }

      const html = await renderClientPage(files, env);

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      console.error('Render error:', err);
      return new Response('An error occurred loading this page. Please try again.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  },
} satisfies ExportedHandler<Env>;
