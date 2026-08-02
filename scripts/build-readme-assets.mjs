#!/usr/bin/env node
// Renders the SVG panels the profile README points at.
//
// GitHub strips <style>, <script>, class and style attributes out of README
// markdown, so the only way to get the portfolio's look onto the profile is to
// bake it into images. Everything here writes a dark/light pair; the README
// picks between them with <picture media="(prefers-color-scheme: dark)">.
//
// The data half is lifted from the portfolio's scripts/fetch-github-data.mjs —
// same GraphQL-then-mirror fallback for the contribution calendar, same
// Linguist colours, same summarize(). If every source fails the committed SVGs
// are left untouched, so a bad build never ships an empty grid.
//
// Fonts are inlined as data URIs, one static instance per weight a panel uses
// (see subset-font.py). Every font-family still ends in a system stack, so a
// machine without fonttools renders plain text rather than blank text.

import { writeFile, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const run = promisify(execFile);

const LOGIN = 'mohammadumar-dev';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const FONTS = join(ASSETS, 'fonts');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const nf = new Intl.NumberFormat('en-US');

// ------------------------------------------------------------------- content
// The only prose on the profile. Everything else on the page is a number.

const NAME = ['Mohammad', 'Umar Shaikh'];
const BIO = 'Backend engineer. Java and Spring Boot systems that stay up under load, plus production LLM tooling.';
const META = ['Pune, India', 'Data Innovation Technologies', 'B.Sc. CS 2026'];

const STACK = [
  ['Languages', ['Java', 'Go', 'Python', 'TypeScript', 'JavaScript', 'SQL']],
  ['Backend', ['Spring Boot', 'Node.js', 'FastAPI', 'REST', 'Microservices', 'Hibernate']],
  ['Frontend', ['React', 'Next.js', 'Tailwind', 'shadcn/ui', 'Angular']],
  ['Data', ['PostgreSQL', 'Redis', 'MongoDB', 'Prisma', 'Elasticsearch', 'Flyway']],
  ['DevOps', ['Docker', 'AWS', 'Linux', 'Nginx', 'Kubernetes', 'GitHub Actions']],
  ['AI', ['Spring AI', 'Claude', 'OpenAI', 'Groq', 'RAG', 'MCP']],
];

// Linguist colours for the languages that appear in these repos.
const LANGUAGE_COLORS = {
  TypeScript: '#3178c6',
  Java: '#b07219',
  Go: '#00ADD8',
  Python: '#3572A5',
  JavaScript: '#f1e05a',
  Kotlin: '#A97BFF',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Shell: '#89e051',
  Dockerfile: '#384d54',
  FreeMarker: '#0050b2',
  Makefile: '#427819',
  Batchfile: '#C1F12E',
  PLpgSQL: '#336790',
};
const FALLBACK_COLOR = '#8b949e';

// ------------------------------------------------------------------ network
// One choke point for every outbound request, because two of the three data
// sources are outside this repo's control.

const API_HOST = 'api.github.com';
const MIRROR_HOST = 'github-contributions-api.jogruber.de';
const UA = `${LOGIN}-profile-build`;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** Reads a response body but refuses to buffer an unbounded one. */
async function readCapped(res, host) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`response from ${host} exceeded ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The credential is attached by host, never by caller. GITHUB_TOKEN can write
 * to this repo, so it must not ride along to the contributions mirror or to any
 * URL that arrived inside an API response. Redirects are rejected rather than
 * followed for the same reason — a 302 is the cheapest way to move a header
 * somewhere it was not meant to go. Every call is time-boxed and size-capped so
 * one slow or hostile host cannot hang or exhaust the daily build.
 */
async function getJSON(url, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`refusing non-https URL (${target.protocol})`);
  if (target.host !== API_HOST && target.host !== MIRROR_HOST) {
    throw new Error(`refusing request to unexpected host: ${target.host}`);
  }

  const headers = { Accept: accept, 'User-Agent': UA };
  if (TOKEN && target.host === API_HOST) headers.Authorization = `Bearer ${TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(target, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Report the host, not the URL: query strings are the usual place a secret
  // ends up in a log line.
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${target.host}${target.pathname}`);
  return JSON.parse(await readCapped(res, target.host));
}

// -------------------------------------------------------------- validation
// Everything below this line came off the network. None of it is trusted for
// its shape, its size or its range — the panels index colour ramps with it and
// size layout from its length.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400; // a year plus slack; anything larger is not a calendar
const MAX_COUNT = 100_000;

const clampInt = (value, lo, hi, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback;
};

function normalizeDays(raw, source) {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${source} returned no days`);
  if (raw.length > MAX_DAYS) throw new Error(`${source} returned ${raw.length} days, expected <= ${MAX_DAYS}`);
  return raw.map((d, i) => {
    const date = d?.date;
    if (typeof date !== 'string' || !ISO_DAY.test(date)) {
      throw new Error(`${source} day ${i} has no usable date`);
    }
    return {
      date,
      count: clampInt(d.count, 0, MAX_COUNT),
      // Indexes THEMES[*].ramp — a value outside 0..4 renders fill="undefined".
      level: clampInt(d.level, 0, 4),
    };
  });
}

// -------------------------------------------------------------- contributions

async function contributionsFromGraphQL() {
  if (!TOKEN) throw new Error('no token');
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 364);
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){
      contributionsCollection(from:$from,to:$to){
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ date contributionCount contributionLevel } }
        }
      }
    }
  }`;
  const json = await getJSON('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query,
      variables: { login: LOGIN, from: from.toISOString(), to: to.toISOString() },
    }),
  });
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));

  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error('graphql returned no calendar');

  const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const days = normalizeDays(
    (cal.weeks ?? []).flatMap((w) =>
      (w?.contributionDays ?? []).map((d) => ({
        date: d?.date,
        count: d?.contributionCount,
        // Own-key only: LEVELS['constructor'] is a function, and `?? 0` would
        // happily let it through. Same trap as colorFor().
        level: Object.hasOwn(LEVELS, d?.contributionLevel ?? '') ? LEVELS[d.contributionLevel] : 0,
      })),
    ),
    'graphql',
  );
  return { total: totalOf(cal.totalContributions, days), days, source: 'graphql' };
}

// The mirror is a third party. It gets no credential (see getJSON) and its
// payload goes through the same normalizer as GitHub's own.
async function contributionsFromMirror() {
  const json = await getJSON(`https://${MIRROR_HOST}/v4/${encodeURIComponent(LOGIN)}?y=last`, {
    accept: 'application/json',
  });
  const days = normalizeDays(json?.contributions, 'mirror');
  return { total: totalOf(json?.total?.lastYear, days), days, source: 'mirror' };
}

const totalOf = (reported, days) => {
  const sum = days.reduce((a, d) => a + d.count, 0);
  const n = Number(reported);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : sum;
};

function summarize(days) {
  let best = { date: days[0]?.date ?? null, count: 0 };
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.count > best.count) best = { date: d.date, count: d.count };
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  // Current streak ignores today when it is still empty — the day is not over yet.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].count > 0) current += 1;
    else if (i === days.length - 1) continue;
    else break;
  }
  const active = days.filter((d) => d.count > 0).length;
  return { bestDay: best, longestStreak: longest, currentStreak: current, activeDays: active };
}

// ---------------------------------------------------------------- repos + user

async function fetchRepos() {
  const raw = await getJSON(
    `https://api.github.com/users/${encodeURIComponent(LOGIN)}/repos?per_page=100&sort=updated`,
  );
  if (!Array.isArray(raw)) throw new Error('repos endpoint did not return a list');
  const owned = raw.filter((r) => r && !r.fork && !r.archived && typeof r.full_name === 'string');

  const byteTotals = new Map();
  for (const repo of owned) {
    // Built here rather than read from repo.languages_url: that field is a URL
    // supplied by the response, and following it would point a token-bearing
    // request wherever the response said to. getJSON would reject an off-host
    // URL anyway — this keeps it from ever getting that far.
    const [owner, name] = repo.full_name.split('/');
    const url =
      owner && name
        ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/languages`
        : null;
    try {
      if (!url) throw new Error(`unparseable full_name: ${repo.full_name}`);
      const langs = await getJSON(url);
      for (const [lang, bytes] of Object.entries(langs ?? {})) {
        const n = clampInt(bytes, 0, Number.MAX_SAFE_INTEGER);
        if (n > 0) byteTotals.set(lang, (byteTotals.get(lang) || 0) + n);
      }
    } catch {
      // A single missing language breakdown must not fail the build.
      if (typeof repo.language === 'string') {
        const approx = clampInt(repo.size, 0, Number.MAX_SAFE_INTEGER) * 1024;
        byteTotals.set(repo.language, (byteTotals.get(repo.language) || 0) + approx);
      }
    }
  }

  const grand = [...byteTotals.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...byteTotals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      pct: +((bytes / grand) * 100).toFixed(2),
      color: colorFor(name),
    }))
    .filter((l) => l.pct >= 0.4)
    .sort((a, b) => b.bytes - a.bytes);

  return {
    languages,
    totals: {
      stars: raw.reduce((a, r) => a + (r?.fork ? 0 : clampInt(r?.stargazers_count, 0, MAX_COUNT)), 0),
      repos: owned.length,
    },
  };
}

/**
 * Language names come from the API, and a plain object lookup walks the
 * prototype chain: LANGUAGE_COLORS['constructor'] is a function, not undefined,
 * so `||` would not fall back and the function's source would be interpolated
 * straight into a fill attribute. Own-key only, and the result still has to
 * look like a hex colour.
 */
function colorFor(name) {
  const hit = Object.hasOwn(LANGUAGE_COLORS, name) ? LANGUAGE_COLORS[name] : null;
  return typeof hit === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(hit) ? hit : FALLBACK_COLOR;
}

// --------------------------------------------------------------------- themes
// Tokens lifted from portfolio.html so the profile and the site read as one
// system. The light column is GitHub's own light palette rather than an
// inversion of the dark one — an inverted contribution ramp looks radioactive.

const THEMES = {
  dark: {
    surfaceTop: '#12181f',
    surfaceBottom: '#0d1117',
    stroke: 'rgba(255,255,255,.09)',
    innerLight: 'rgba(255,255,255,.10)',
    well: '#010409',
    wellStroke: 'rgba(255,255,255,.05)',
    fg: '#e6edf3',
    body: '#c9d1d9',
    muted: '#8b949e',
    dim: '#6e7681',
    accent: '#58a6ff',
    hairline: '#30363d',
    chipFill: 'rgba(88,166,255,.10)',
    chipStroke: 'rgba(88,166,255,.18)',
    chipText: '#a5c9f5',
    bloom: ['#58a6ff', '#a371f7', '#f778ba'],
    // Kept low on purpose, as in portfolio.html: the bloom is there to give the
    // glass something to bend, not to tint the pane off GitHub's near-black.
    bloomOpacity: [0.11, 0.09, 0.06],
    sweep: 'rgba(255,255,255,.07)',
    ramp: ['#151b23', '#033a16', '#196c2e', '#2ea043', '#56d364'],
    cellStroke: 'rgba(255,255,255,.04)',
  },
  light: {
    surfaceTop: '#ffffff',
    surfaceBottom: '#f6f8fa',
    stroke: 'rgba(31,35,40,.14)',
    innerLight: 'rgba(255,255,255,.9)',
    well: '#ffffff',
    wellStroke: 'rgba(31,35,40,.09)',
    fg: '#1f2328',
    body: '#32383f',
    muted: '#59636e',
    dim: '#818b98',
    accent: '#0969da',
    hairline: '#d1d9e0',
    chipFill: 'rgba(9,105,218,.07)',
    chipStroke: 'rgba(9,105,218,.16)',
    chipText: '#0a58ba',
    bloom: ['#54aeff', '#c297ff', '#ff9bce'],
    bloomOpacity: [0.14, 0.12, 0.08],
    sweep: 'rgba(31,35,40,.05)',
    ramp: ['#ebedf0', '#aceebb', '#4ac26b', '#2da44e', '#116329'],
    cellStroke: 'rgba(31,35,40,.05)',
  },
};

// ---------------------------------------------------------------- svg helpers

const SANS_STACK = "'Mona Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO_STACK = "'Mona Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Applied to every value that reaches markup. Quotes are escaped in both
// flavours so the same helper is safe in text nodes and in attributes.
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Advance-width estimates. Good enough to lay out chips and legends without
// shaping the text — every measured run is mono or short.
const mw = (text, size) => text.length * size * 0.6;
const sw = (text, size) => text.length * size * 0.53;

const W = 1000;
const PAD = 40;

/** The glass pane every panel sits in: surface gradient, hairline, clipped bloom. */
function pane(t, h, { bloom = true } = {}) {
  const r = 20;
  const blooms = bloom
    ? t.bloom
        .map((c, i) => {
          const cx = [0.14, 0.78, 0.45][i] * W;
          const cy = [0.1, 0.62, 1.05][i] * h;
          const rx = [0.42, 0.36, 0.34][i] * W;
          return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${(rx * 0.62).toFixed(0)}" fill="url(#bloom${i})"/>`;
        })
        .join('')
    : '';

  const bloomDefs = bloom
    ? t.bloom
        .map(
          (c, i) => `<radialGradient id="bloom${i}">
      <stop offset="0" stop-color="${c}" stop-opacity="${t.bloomOpacity[i]}"/>
      <stop offset="1" stop-color="${c}" stop-opacity="0"/>
    </radialGradient>`,
        )
        .join('\n    ')
    : '';

  return {
    defs: `<linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.surfaceTop}"/>
      <stop offset="1" stop-color="${t.surfaceBottom}"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.sweep}" stop-opacity="0"/>
      <stop offset=".5" stop-color="${t.sweep}"/>
      <stop offset="1" stop-color="${t.sweep}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.hairline}"/>
      <stop offset="1" stop-color="${t.hairline}" stop-opacity="0"/>
    </linearGradient>
    ${bloomDefs}
    <clipPath id="pane"><rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="${r}"/></clipPath>`,
    body: `<rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="${r}" fill="url(#surface)"/>
  <g clip-path="url(#pane)">
    ${blooms}
    <rect class="sweep" x="-${W * 0.5}" y="0" width="${W * 0.5}" height="${h}" fill="url(#sweep)"/>
  </g>
  <rect x="1.5" y="1.5" width="${W - 3}" height="${h - 3}" rx="${r - 0.5}" fill="none" stroke="${t.stroke}"/>
  <path d="M ${r} 2 H ${W - r}" stroke="${t.innerLight}" stroke-width="1" fill="none" opacity=".5"/>`,
  };
}

/** Wraps a panel body into a finished document. */
function doc(t, h, fontCss, defs, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}" font-family="${esc(SANS_STACK)}">
  <title>${esc(title)}</title>
  <defs>
    ${defs}
  </defs>
  <style>
${fontCss}
    text{white-space:pre}
    .sweep{animation:sweep 9s ease-in-out infinite}
    @keyframes sweep{
      0%,100%{transform:translateX(0);opacity:0}
      45%{opacity:1}
      100%{transform:translateX(${W * 1.6}px)}
    }
    .cell{transform-box:fill-box;transform-origin:center}
    .live .cell{animation:cell-in .5s cubic-bezier(.22,.8,.3,1) both}
    @keyframes cell-in{from{opacity:0;transform:scale(.35) translateY(4px)}to{opacity:1;transform:none}}
    .bar{transform-box:fill-box;transform-origin:left center;animation:bar-in .9s cubic-bezier(.22,.8,.3,1) both}
    @keyframes bar-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}
    @media (prefers-reduced-motion:reduce){
      .sweep{animation:none;opacity:0}
      .live .cell,.bar{animation:none}
    }
  </style>
${body}
</svg>
`;
}

const label = (t, x, y, text) =>
  `<text x="${x}" y="${y}" font-family="${esc(MONO_STACK)}" font-size="11" letter-spacing="1.5" fill="${t.dim}">${esc(text.toUpperCase())}</text>`;

// ------------------------------------------------------------------ hero

function heroSVG(t, fontCss) {
  const H = 214;
  const p = pane(t, H);

  // The favicon motif from portfolio.html: a 3×3 contribution block as a mark.
  // Recessed into a well like the calendar's grid, so the two panels share a
  // vocabulary instead of the mark floating on the surface.
  const marks = [1, 3, 2, 4, 2, 3, 2, 4, 1];
  const MARK_X = PAD;
  const MARK_Y = 42;
  const cells = marks
    .map((lvl, i) => {
      const x = MARK_X + 9 + (i % 3) * 15;
      const y = MARK_Y + 9 + Math.floor(i / 3) * 15;
      return `<rect class="cell" x="${x}" y="${y}" width="12" height="12" rx="3" fill="${t.ramp[lvl]}" style="animation-delay:${i * 45}ms"/>`;
    })
    .join('');
  const mark = `<rect x="${MARK_X}" y="${MARK_Y}" width="60" height="60" rx="14" fill="${t.well}" stroke="${t.wellStroke}"/>
  <g class="live">${cells}</g>`;

  // Meta stacks up the right so the pane has weight on both sides instead of a
  // long dead band between the name and the rule.
  const meta = META.map(
    (line, i) =>
      `<text x="${W - PAD}" y="${60 + i * 24}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="12.5" fill="${t.dim}">${esc(line)}</text>`,
  ).join('\n  ');

  const body = `  ${p.body}
  ${mark}
  <text x="${PAD + 78}" y="66" font-size="33" font-weight="800" letter-spacing="-.6" fill="${t.fg}">${esc(NAME[0])}</text>
  <text x="${PAD + 78}" y="101" font-size="33" font-weight="800" letter-spacing="-.6" fill="${t.fg}">${esc(NAME[1])}</text>
  <text x="${PAD + 79}" y="126" font-family="${esc(MONO_STACK)}" font-size="13" fill="${t.accent}">@${esc(LOGIN)}</text>
  ${meta}
  <rect x="${PAD}" y="150" width="${W - PAD * 2}" height="1" fill="url(#rule)"/>
  <rect x="${PAD}" y="168" width="3" height="18" rx="1.5" fill="${t.accent}" opacity=".85"/>
  <text x="${PAD + 14}" y="182" font-size="15.5" fill="${t.body}">${esc(BIO)}</text>`;

  return doc(t, H, fontCss, p.defs, body, `${NAME.join(' ')} — ${BIO}`);
}

// ------------------------------------------------------------------ pulse

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parseDay = (iso) => new Date(`${iso}T00:00:00Z`);
const pretty = (iso) => {
  const d = parseDay(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

function pulseSVG(t, fontCss, data) {
  const c = data.contributions;
  const days = c.days;

  const GAP = 3;
  const WD = 26; // weekday gutter
  const WELL = 10; // recessed padding around the grid
  const WELL_Y = 96;

  // Pad the first column so weekdays line up with real rows (Sunday first).
  const lead = parseDay(days[0].date).getUTCDay();
  const weeks = Math.ceil((days.length + lead) / 7);

  // Size the cell so the well ends flush with the pane's right padding — a
  // fixed cell leaves a ragged margin whenever the year is 52 weeks, not 53.
  const span = W - PAD * 2 - WD - WELL * 2;
  const CELL = +((span - GAP * (weeks - 1)) / weeks).toFixed(3);

  const gridX = PAD + WD + WELL;
  const gridY = WELL_Y + WELL;

  const wellW = W - PAD * 2 - WD;
  const wellH = 7 * CELL + 6 * GAP + WELL * 2;

  const ruleY = Math.round(WELL_Y + wellH + 22);
  const statY = ruleY + 38;
  const H = statY + 40;

  const cells = days
    .map((day, i) => {
      const idx = i + lead;
      const week = Math.floor(idx / 7);
      const row = idx % 7;
      const x = (gridX + week * (CELL + GAP)).toFixed(2);
      const y = (gridY + row * (CELL + GAP)).toFixed(2);
      return `<rect class="cell" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${t.ramp[day.level]}" stroke="${t.cellStroke}" style="animation-delay:${week * 12}ms"/>`;
    })
    .join('\n    ');

  // Label a month at the first full week it owns, never twice in a row.
  const marks = [];
  let lastMonth = -1;
  days.forEach((day, i) => {
    const d = parseDay(day.date);
    const month = d.getUTCMonth();
    if (month !== lastMonth && d.getUTCDate() <= 7) {
      const week = Math.floor((i + lead) / 7);
      if (!marks.length || week - marks[marks.length - 1].week >= 3) marks.push({ week, label: MONTHS[month] });
      lastMonth = month;
    }
  });
  // The ramp key owns the right end of this row, so drop any month that would
  // run into it rather than letting the two overlap.
  const monthCutoff = W - PAD - 34 - (5 * 10 + 4 * 3) - 44;
  const months = marks
    .map((m) => ({ ...m, x: gridX + m.week * (CELL + GAP) }))
    .filter((m) => m.x < monthCutoff)
    .map(
      (m) =>
        `<text x="${m.x.toFixed(1)}" y="${WELL_Y - 8}" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">${m.label}</text>`,
    )
    .join('\n  ');

  const weekdays = [
    [1, 'Mon'],
    [3, 'Wed'],
    [5, 'Fri'],
  ]
    .map(
      ([row, name]) =>
        `<text x="${PAD}" y="${(gridY + row * (CELL + GAP) + CELL * 0.78).toFixed(1)}" font-family="${esc(MONO_STACK)}" font-size="10" fill="${t.dim}">${name}</text>`,
    )
    .join('\n  ');

  const stats = [
    ['Contributions', c.total],
    ['Active days', c.activeDays],
    ['Current streak', c.currentStreak],
    ['Longest streak', c.longestStreak],
    ['Public repos', data.totals.repos],
    ['Stars earned', data.totals.stars],
  ];
  const colW = (W - PAD * 2) / stats.length;
  const statCells = stats
    .map(([name, value], i) => {
      const x = PAD + colW * i;
      const divider =
        i > 0
          ? `<rect x="${(x - 14).toFixed(1)}" y="${statY - 22}" width="1" height="42" fill="${t.hairline}" opacity=".6"/>`
          : '';
      return `${divider}
  <text x="${x.toFixed(1)}" y="${statY}" font-family="${esc(MONO_STACK)}" font-size="23" font-weight="600" fill="${t.fg}">${esc(nf.format(value ?? 0))}</text>
  <text x="${x.toFixed(1)}" y="${statY + 20}" font-family="${esc(MONO_STACK)}" font-size="10.5" letter-spacing="1.2" fill="${t.dim}">${esc(name.toUpperCase())}</text>`;
    })
    .join('\n  ');

  // Ramp key, right-aligned on the month row. Sits on the baseline the month
  // labels already establish so it reads as part of the grid's chrome.
  const KEY = 10;
  const keyW = 5 * KEY + 4 * 3;
  const keyRight = W - PAD;
  const keyX = keyRight - 34 - keyW;
  const legend = `<text x="${(keyX - 8).toFixed(1)}" y="${WELL_Y - 8}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="10" fill="${t.dim}">Less</text>
  ${t.ramp
    .map(
      (fill, i) =>
        `<rect x="${(keyX + i * (KEY + 3)).toFixed(1)}" y="${WELL_Y - 17}" width="${KEY}" height="${KEY}" rx="2.5" fill="${fill}" stroke="${t.cellStroke}"/>`,
    )
    .join('\n  ')}
  <text x="${keyRight}" y="${WELL_Y - 8}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="10" fill="${t.dim}">More</text>`;

  const range = `${pretty(c.start)} — ${pretty(c.end)}`;
  const p = pane(t, H);

  const body = `  ${p.body}
  ${label(t, PAD, 52, 'Contributions')}
  <text x="${W - PAD}" y="52" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">${esc(range)}</text>
  ${months}
  ${legend}
  ${weekdays}
  <rect x="${PAD + WD}" y="${WELL_Y}" width="${wellW}" height="${wellH.toFixed(2)}" rx="12" fill="${t.well}" stroke="${t.wellStroke}"/>
  <g class="live">
    ${cells}
  </g>
  <rect x="${PAD}" y="${ruleY}" width="${W - PAD * 2}" height="1" fill="${t.hairline}" opacity=".5"/>
  ${statCells}`;

  return doc(
    t,
    H,
    fontCss,
    p.defs,
    body,
    `${nf.format(c.total)} contributions between ${pretty(c.start)} and ${pretty(c.end)}`,
  );
}

// ------------------------------------------------------------------ languages

function langsSVG(t, fontCss, data) {
  const H = 166;
  const p = pane(t, H);
  const langs = data.languages.slice(0, 8);
  const shown = langs.reduce((a, l) => a + l.pct, 0) || 1;

  const barY = 100;
  const barW = W - PAD * 2;
  const barH = 12;

  let x = PAD;
  const segments = langs
    .map((l, i) => {
      const w = (l.pct / shown) * barW;
      const seg = `<rect x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w, 1).toFixed(2)}" height="${barH}" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join('\n    ');

  // One row of dot + name + percent, laid out left to right until it runs out.
  const keyY = barY + 40;
  let kx = PAD;
  const key = langs
    .map((l) => {
      const text = `${l.name} ${l.pct.toFixed(1)}%`;
      const item = `<circle cx="${(kx + 4).toFixed(1)}" cy="${keyY - 4}" r="4" fill="${l.color}"/>
  <text x="${(kx + 14).toFixed(1)}" y="${keyY}" font-family="${esc(MONO_STACK)}" font-size="11.5" fill="${t.muted}">${esc(text)}</text>`;
      kx += 14 + mw(text, 11.5) + 20;
      return item;
    })
    .join('\n  ');

  // The bar answers "what is the mix"; it does not answer "what does he write".
  // The lead language gets stated outright above it.
  const lead = langs[0];
  const headline = lead
    ? `<circle cx="${PAD + 6}" cy="${barY - 26}" r="6" fill="${lead.color}"/>
  <text x="${PAD + 20}" y="${barY - 21}" font-size="21" font-weight="800" letter-spacing="-.3" fill="${t.fg}">${esc(lead.name)}</text>
  <text x="${(PAD + 30 + sw(lead.name, 21)).toFixed(1)}" y="${barY - 21}" font-family="${esc(MONO_STACK)}" font-size="13" fill="${t.muted}">${esc(`${lead.pct.toFixed(1)}% of ${langs.length} languages`)}</text>`
    : '';

  const body = `  ${p.body}
  ${label(t, PAD, 46, 'Languages')}
  <text x="${W - PAD}" y="46" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">by bytes across public repos</text>
  ${headline}
  <rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6" fill="${t.well}" stroke="${t.wellStroke}"/>
  <g class="bar" clip-path="url(#barclip)">
    ${segments}
  </g>`;

  const defs = `${p.defs}
    <clipPath id="barclip"><rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6"/></clipPath>`;

  return doc(
    t,
    H,
    fontCss,
    defs,
    `${body}\n  ${key}`,
    `Language breakdown by bytes: ${langs.map((l) => `${l.name} ${l.pct} percent`).join(', ')}`,
  );
}

// ------------------------------------------------------------------ stack

function stackSVG(t, fontCss) {
  const ROW_H = 42;
  const TOP = 80;
  const H = TOP + (STACK.length - 1) * ROW_H + 38;
  const p = pane(t, H);

  const LABEL_W = 108;
  const rows = STACK.map(([name, items], r) => {
    const y = TOP + r * ROW_H;
    let x = PAD + LABEL_W;
    const chips = items
      .map((item) => {
        const w = mw(item, 12) + 22;
        const chip = `<rect x="${x.toFixed(1)}" y="${y - 15}" width="${w.toFixed(1)}" height="24" rx="12" fill="${t.chipFill}" stroke="${t.chipStroke}"/>
  <text x="${(x + w / 2).toFixed(1)}" y="${y + 1}" text-anchor="middle" font-family="${esc(MONO_STACK)}" font-size="12" fill="${t.chipText}">${esc(item)}</text>`;
        x += w + 8;
        return chip;
      })
      .join('\n  ');
    return `<text x="${PAD}" y="${y + 1}" font-family="${esc(MONO_STACK)}" font-size="11" letter-spacing="1.2" fill="${t.dim}">${esc(name.toUpperCase())}</text>
  ${chips}`;
  }).join('\n  ');

  const body = `  ${p.body}
  ${label(t, PAD, 48, 'Stack')}
  <rect x="${PAD}" y="60" width="${W - PAD * 2}" height="1" fill="url(#rule)"/>
  ${rows}`;

  return doc(t, H, fontCss, p.defs, body, `Stack: ${STACK.map(([n, i]) => `${n} — ${i.join(', ')}`).join('; ')}`);
}

// ------------------------------------------------------------------ rule

function ruleSVG(t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="2" viewBox="0 0 ${W} 2" role="presentation">
  <defs>
    <linearGradient id="r" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.hairline}" stop-opacity="0"/>
      <stop offset=".5" stop-color="${t.hairline}"/>
      <stop offset="1" stop-color="${t.hairline}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="1" y="0.5" fill="url(#r)"/>
</svg>
`;
}

// ------------------------------------------------------------------- fonts
// Each panel embeds only the weights it actually draws with. Faces are pinned
// static instances (see subset-font.py) — a variable face is ten times the size
// and every byte here is repeated in every panel that uses it.

const FACES = {
  sans400: { file: 'MonaSans.woff2', family: 'Mona Sans', weight: 400, pins: 'wght=400,wdth=100,opsz=16' },
  sans800: { file: 'MonaSans.woff2', family: 'Mona Sans', weight: 800, pins: 'wght=800,wdth=112,opsz=32' },
  mono400: { file: 'MonaSansMono.woff2', family: 'Mona Sans Mono', weight: 400, pins: 'wght=400,opsz=16' },
  mono600: { file: 'MonaSansMono.woff2', family: 'Mona Sans Mono', weight: 600, pins: 'wght=600,opsz=16' },
};

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'subset-font.py');

/** Builds every face once; returns a name → @font-face map, or {} if fonttools is missing. */
async function buildFaces() {
  const built = {};
  // A fixed name in the shared /tmp is a symlink target anyone on the machine
  // can plant. mkdtemp gives a 0700 directory with an unguessable name.
  let workdir;
  try {
    workdir = await mkdtemp(join(tmpdir(), 'profile-fonts-'));
    await Promise.all(
      Object.entries(FACES).map(async ([name, face]) => {
        const out = join(workdir, `${name}.woff2`);
        // execFile, not exec: argv is passed through, never a shell string.
        await run('python3', [HELPER, join(FONTS, face.file), out, face.pins], { timeout: 60_000 });
        const b64 = (await readFile(out)).toString('base64');
        built[name] =
          `    @font-face{font-family:'${face.family}';font-weight:${face.weight};font-style:normal;` +
          `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
      }),
    );
    const kb = Math.round(Object.values(built).join('').length / 1024);
    console.log(`fonts: built ${Object.keys(built).length} static faces (${kb} KB of base64 in total)`);
    return built;
  } catch (err) {
    console.warn(`fonts: not embedded (${err.message}) — panels fall back to the system stack`);
    return {};
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const css = (faces, names) => names.map((n) => faces[n] || '').filter(Boolean).join('\n');

// -------------------------------------------------------------------- main

async function main() {
  await mkdir(ASSETS, { recursive: true });

  let contributions;
  for (const attempt of [contributionsFromGraphQL, contributionsFromMirror]) {
    try {
      contributions = await attempt();
      console.log(`contributions: ${contributions.total} via ${contributions.source}`);
      break;
    } catch (err) {
      console.warn(`contributions via ${attempt.name} failed: ${err.message}`);
    }
  }

  let user;
  let repoData;
  try {
    [user, repoData] = await Promise.all([
      getJSON(`https://api.github.com/users/${encodeURIComponent(LOGIN)}`),
      fetchRepos(),
    ]);
  } catch (err) {
    console.warn(`profile/repos failed: ${err.message}`);
  }

  const faces = await buildFaces();

  // The hero, stack and rule need no network, so they are always safe to write.
  const written = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    await writeFile(join(ASSETS, `stack-${name}.svg`), stackSVG(theme, css(faces, ['mono400'])), 'utf8');
    await writeFile(join(ASSETS, `rule-${name}.svg`), ruleSVG(theme), 'utf8');
    await writeFile(
      join(ASSETS, `hero-${name}.svg`),
      heroSVG(theme, css(faces, ['sans400', 'sans800', 'mono400'])),
      'utf8',
    );
    written.push(`stack-${name}`, `rule-${name}`, `hero-${name}`);
  }

  if (!contributions || !repoData) {
    console.warn('live data unavailable — keeping the committed pulse/langs panels');
    console.log(`wrote ${written.length} panels`);
    return;
  }

  const data = {
    contributions: {
      total: contributions.total,
      start: contributions.days[0].date,
      end: contributions.days[contributions.days.length - 1].date,
      ...summarize(contributions.days),
      days: contributions.days,
    },
    languages: repoData.languages,
    totals: {
      ...repoData.totals,
      repos: clampInt(user?.public_repos, 0, MAX_COUNT, repoData.totals.repos),
    },
  };

  for (const [name, theme] of Object.entries(THEMES)) {
    await writeFile(
      join(ASSETS, `pulse-${name}.svg`),
      pulseSVG(theme, css(faces, ['mono400', 'mono600']), data),
      'utf8',
    );
    await writeFile(join(ASSETS, `langs-${name}.svg`), langsSVG(theme, css(faces, ['mono400']), data), 'utf8');
    written.push(`pulse-${name}`, `langs-${name}`);
  }

  console.log(
    `wrote ${written.length} panels — ${nf.format(data.contributions.total)} contributions, ` +
      `${data.totals.repos} repos, ${data.totals.stars} stars, ${data.languages.length} languages`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
