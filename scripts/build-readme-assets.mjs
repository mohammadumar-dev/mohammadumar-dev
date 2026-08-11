#!/usr/bin/env node
// Renders the SVG panels the profile README points at.
//
// GitHub strips <style>, <script>, class and style attributes out of README
// markdown, so the only way to get the portfolio's look onto the profile is to
// bake it into images. Everything here writes a dark/light pair; the README
// picks between them with <picture media="(prefers-color-scheme: dark)">.
//
// There are two panels and both earn their place by showing something the
// profile page cannot. GitHub already draws a contribution calendar directly
// below this README, already lists the pinned repos, and already carries the
// name, bio, company and social links in its sidebar — so none of that is here.
// What is left is the commit rhythm (GitHub has the timestamps but never plots
// them by hour) and the language mix (GitHub never sums bytes across repos).
//
// If the live data fails the committed SVGs are left untouched, so a bad build
// never ships an empty dial.
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
import { createHash } from 'node:crypto';

const run = promisify(execFile);

const LOGIN = 'mohammadumar-dev';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const FONTS = join(ASSETS, 'fonts');
const README = join(ROOT, 'README.md');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const nf = new Intl.NumberFormat('en-US');

// A circadian chart is only meaningful in the author's own time. GraphQL hands
// back every timestamp normalised to UTC, so the hour has to be resolved against
// a fixed zone — fixed rather than the runner's, because CI runs in UTC and the
// dial would otherwise rotate six hours the moment it moved off a laptop. India
// observes no DST, so this is also what keeps the output byte-stable.
const TZ = 'Asia/Kolkata';
const TZ_LABEL = 'IST';

// ------------------------------------------------------------------- content
// The only authored text left on the profile. Everything else is a number the
// build went and fetched.

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

// ------------------------------------------------------------------ network
// One choke point for every outbound request. Both panels now read from a single
// host, and the allowlist is what keeps it that way: a URL that arrives inside an
// API response cannot redirect this build somewhere else.

const API_HOST = 'api.github.com';
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
 * The credential is attached by host, never by caller. GITHUB_TOKEN can write to
 * this repo, so it must not ride along to any URL that arrived inside an API
 * response. Redirects are rejected rather than followed for the same reason — a
 * 302 is the cheapest way to move a header somewhere it was not meant to go.
 * Every call is time-boxed and size-capped so one slow or hostile host cannot
 * hang or exhaust the daily build.
 */
async function getJSON(url, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`refusing non-https URL (${target.protocol})`);
  if (target.host !== API_HOST) {
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

const clampInt = (value, lo, hi, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback;
};

// ------------------------------------------------------------- commit rhythm
// The dial needs the hour a commit landed, and no summary endpoint carries it:
// contributionsCollection counts days, the events API only reaches back ninety
// of them. So the timestamps are walked directly, repo by repo, and the caps
// below are what keep "walk every commit" from being an unbounded promise on an
// account that grows.

const WINDOW_DAYS = 365;
const MAX_REPOS = 60;
const MAX_PAGES = 6; // × 100 commits, per repo
const MAX_COMMITS = 4000; // across all repos, the point at which the dial stops changing shape

const REPOS_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    id
    contributionsCollection(from:$from,to:$to){
      commitContributionsByRepository(maxRepositories:${MAX_REPOS}){
        repository{ name owner{ login } }
      }
    }
  }
}`;

const HISTORY_QUERY = `query($owner:String!,$name:String!,$author:ID!,$since:GitTimestamp!,$cursor:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{
      target{
        ... on Commit{
          history(author:{id:$author},since:$since,first:100,after:$cursor){
            pageInfo{ hasNextPage endCursor }
            nodes{ committedDate }
          }
        }
      }
    }
  }
}`;

const graphql = async (query, variables) => {
  const json = await getJSON('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
};

/**
 * Every commit timestamp this account authored in the last year, as ISO strings.
 *
 * The author filter is by node id rather than by email: a commit made from the
 * web UI, from a phone, or under a `noreply` address is the same person, and
 * matching on the address would quietly drop whole categories of work from the
 * dial. GitHub already resolves the identity — this just asks it to.
 */
async function commitTimesFromGraphQL() {
  if (!TOKEN) throw new Error('no token');

  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (WINDOW_DAYS - 1));
  const since = from.toISOString();

  const head = await graphql(REPOS_QUERY, { login: LOGIN, from: since, to: to.toISOString() });
  const author = head?.user?.id;
  if (typeof author !== 'string' || !author) throw new Error('graphql returned no user id');

  const repos = (head.user.contributionsCollection?.commitContributionsByRepository ?? [])
    .map((entry) => ({ owner: entry?.repository?.owner?.login, name: entry?.repository?.name }))
    .filter((r) => typeof r.owner === 'string' && typeof r.name === 'string');
  if (!repos.length) throw new Error('graphql returned no repositories with commits');

  const times = [];
  for (const repo of repos) {
    if (times.length >= MAX_COMMITS) break;
    let cursor = null;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data = await graphql(HISTORY_QUERY, { ...repo, author, since, cursor });
        const history = data?.repository?.defaultBranchRef?.target?.history;
        // An empty repo has no defaultBranchRef, and a non-Commit target (a tag)
        // matches no inline fragment. Both are normal, not failures.
        if (!history) break;
        for (const node of history.nodes ?? []) {
          if (typeof node?.committedDate === 'string') times.push(node.committedDate);
        }
        if (!history.pageInfo?.hasNextPage || times.length >= MAX_COMMITS) break;
        cursor = history.pageInfo.endCursor;
      }
    } catch (err) {
      // One unreadable repo is a gap in the sample, not a reason to lose the panel.
      console.warn(`commits: skipped ${repo.owner}/${repo.name} (${err.message})`);
    }
  }

  if (!times.length) throw new Error('no commit timestamps in the window');
  return { times, days: WINDOW_DAYS };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// The hours the dial calls "after dark". A window, not a threshold: the point is
// the stretch either side of midnight, which a `hour >= 22` test cannot express.
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3];

/**
 * Timestamps -> a 7×24 grid of counts, in local time.
 *
 * Intl does the zone conversion rather than an offset constant, so this stays
 * correct if TZ is ever pointed at a zone that observes DST. hourCycle is pinned
 * to h23 because the default for en-US is h12, and 'h24' would render midnight
 * as 24 and index off the end of the row.
 */
function bucketCommits(times) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });

  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let total = 0;

  for (const iso of times) {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) continue;
    const parts = fmt.formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    // Both indexes reach into fixed-length arrays; an unexpected locale string
    // or a NaN hour would write to a key that is not a cell at all.
    if (!Object.hasOwn(WEEKDAY_INDEX, weekday ?? '')) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    grid[WEEKDAY_INDEX[weekday]][hour] += 1;
    total += 1;
  }

  if (!total) throw new Error('no commit timestamps survived bucketing');
  return { grid, total };
}

/** The widest `span` hours of the day, treating the day as a circle. */
function peakWindow(hourTotals, span = 3) {
  let best = { start: 0, sum: -1 };
  for (let start = 0; start < 24; start += 1) {
    let sum = 0;
    for (let k = 0; k < span; k += 1) sum += hourTotals[(start + k) % 24];
    if (sum > best.sum) best = { start, sum };
  }
  return { start: best.start, end: (best.start + span) % 24 };
}

function summarizeRhythm({ grid, total }, days) {
  const hourTotals = new Array(24).fill(0);
  const dayTotals = new Array(7).fill(0);
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      hourTotals[h] += grid[d][h];
      dayTotals[d] += grid[d][h];
    }
  }

  const peakDay = dayTotals.indexOf(Math.max(...dayTotals));
  const night = NIGHT_HOURS.reduce((a, h) => a + hourTotals[h], 0);

  return {
    grid,
    total,
    days,
    peak: peakWindow(hourTotals),
    peakDay: WEEKDAYS[peakDay],
    nightPct: Math.round((night / total) * 100),
    hoursActive: hourTotals.filter((n) => n > 0).length,
  };
}

/**
 * Counts -> ramp levels 0..4, ranked among the non-empty cells.
 *
 * Scaling against the single busiest cell is what flattens a chart: one 3am
 * marathon would put almost every other hour of the year into the bottom step,
 * and the dial would read as one tone with a bright speck in it. Ranking instead
 * gives each level roughly a quarter of the active cells, so the whole ramp gets
 * used and no single outlier can compress the rest. It matters more here than it
 * would with colour — a monochrome ramp has less to separate its steps with.
 */
function levelsFor(counts) {
  const active = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!active.length) return counts.map(() => 0);

  const at = (p) => active[Math.floor(p * (active.length - 1))];
  const [t1, t2, t3] = [at(0.25), at(0.5), at(0.75)];

  return counts.map((n) => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4;
  });
}

// ---------------------------------------------------------------------- repos
// Only the language bytes are read here. Repo and star counts used to be printed
// too, until it turned out the profile's own Repositories and Stars tabs sit
// four pixels above wherever this renders.

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

  const languages = summarizeLanguages(byteTotals);
  if (!languages.length) throw new Error('no language bytes across public repos');
  return { languages, languageCount: byteTotals.size };
}

// ------------------------------------------------------------------ languages

const TOP_N = 5;
const OTHER = 'Other';

/**
 * Editorial ceilings, applied after the top-N slice.
 *
 * One generated project can leave a single language holding three quarters of
 * the account, which says more about how a framework scaffolds a repo than
 * about what actually gets written. Capping trims the leader and hands back
 * what it shaved — in proportion, so the ordering underneath is untouched and
 * the bar still sums to 100.
 */
const CAPS = { TypeScript: 25 };

/**
 * Redistributes everything above each cap across the languages that have none.
 *
 * Each uncapped language receives a share of the excess proportional to how big
 * it already was, which is the same as multiplying it by 1 + excess/othersTotal.
 * Capped languages are held fixed while that happens, so a second cap cannot
 * push the first back over its ceiling — with one cap this settles in a single
 * pass, and the loop is what keeps that true if another is ever added.
 */
function applyCaps(langs) {
  for (let pass = 0; pass < 8; pass += 1) {
    const over = langs.filter((l) => Object.hasOwn(CAPS, l.name) && l.pct > CAPS[l.name]);
    if (!over.length) return langs;

    for (const lang of over) {
      const others = langs.filter((l) => l !== lang && !Object.hasOwn(CAPS, l.name));
      const othersTotal = others.reduce((a, l) => a + l.pct, 0);
      // Nothing to hand the excess to, so there is no cap to apply: trimming
      // anyway would drop the difference on the floor and draw a bar that stops
      // a quarter of the way across. A cap is a statement about proportion
      // between languages, and with only one language there is no proportion.
      if (othersTotal <= 0) continue;

      const excess = lang.pct - CAPS[lang.name];
      lang.pct = CAPS[lang.name];
      for (const o of others) o.pct += excess * (o.pct / othersTotal);
    }
  }
  return langs;
}

/**
 * Picks the one-decimal numbers the panel prints, so that they sum to exactly
 * 100.0 rather than to whatever independent rounding lands on.
 *
 * Rounding each share on its own is what makes a chart print 25.0 + 55.0 + 7.4
 * + 5.7 + 4.4 + 2.6 = 100.1 and invite the reader to notice. Largest-remainder
 * hands the leftover tenths to the shares that were cut hardest, so every label
 * stays within a tenth of its true value and the column adds up.
 *
 * `pct` keeps full precision and is what the bar is drawn from; `label` is only
 * ever printed.
 */
function labelPercents(langs) {
  if (!langs.length) return langs;

  // Only meaningful for a set that genuinely covers the whole account. If a cap
  // could not be redistributed the shares will not total 100, and forcing them
  // to would be inventing data — round each on its own instead.
  const total = langs.reduce((a, l) => a + l.pct, 0);
  if (Math.abs(total - 100) > 0.001) {
    for (const l of langs) l.label = +l.pct.toFixed(1);
    return langs;
  }

  const tenths = langs.map((l) => l.pct * 10);
  const floors = tenths.map(Math.floor);
  const leftover = Math.round(1000 - floors.reduce((a, b) => a + b, 0));

  const byRemainder = tenths
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac);

  const out = floors.slice();
  for (let k = 0; k < leftover && k < byRemainder.length; k += 1) out[byRemainder[k].i] += 1;

  langs.forEach((l, i) => {
    l.label = out[i] / 10;
  });
  return langs;
}

/**
 * Byte totals -> the segments the bar draws.
 *
 * Everything outside the top five collapses into one "Other" slice rather than
 * being dropped. The previous cut here discarded anything under 0.4%, so the
 * segments quietly summed to less than 100 and a slice of the account went
 * missing from its own chart.
 *
 * Percentages stay at full precision the whole way through; the panel rounds
 * once, when it prints them. Rounding inside the pipeline — as this did — and
 * then redistributing on top of the rounded values is what makes a bar add up
 * to 99.8.
 */
function summarizeLanguages(byteTotals) {
  const grand = [...byteTotals.values()].reduce((a, b) => a + b, 0);
  if (grand <= 0) return [];

  const sorted = [...byteTotals.entries()].sort((a, b) => b[1] - a[1]);
  const languages = sorted.slice(0, TOP_N).map(([name, bytes]) => ({
    name,
    bytes,
    pct: (bytes / grand) * 100,
    color: colorFor(name),
  }));

  const restBytes = sorted.slice(TOP_N).reduce((a, [, bytes]) => a + bytes, 0);
  if (restBytes > 0) {
    // Not a language, so it gets no Linguist colour: the panel resolves a null
    // colour to the theme's dimmest neutral rather than to a language's hex.
    languages.push({ name: OTHER, bytes: restBytes, pct: (restBytes / grand) * 100, color: null });
  }

  return labelPercents(applyCaps(languages).sort((a, b) => b.pct - a.pct));
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
  // null, never a fallback hex: a language this map has never heard of resolves
  // to the theme's own neutral at render time, which keeps the palette in one
  // place instead of leaving a stray grey from another design in the middle of
  // this one.
  return typeof hit === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(hit) ? hit : null;
}

// --------------------------------------------------------------------- themes
// Graphite surfaces, indigo data.
//
// The chrome — canvas, glass, rims, hairlines, every piece of text — stays
// neutral, and hierarchy inside it is still carried by luminance and weight
// rather than hue. Colour is spent in exactly two places: the heat ramp, which
// is the one thing on these panels that encodes a quantity, and a breath of it
// in the pane's bloom so the glass belongs to the same temperature as what sits
// on it. Everything that is not measuring something stays grey, which is what
// keeps a palette from becoming decoration.
//
// The language bar is the third colour and answers to nobody: it wears each
// language's own Linguist hex. Cool ramp, warm bar — the leading language here
// is Java at #b07219, and picking indigo rather than amber is what keeps the
// dial and the bar from reading as one confused system.

const THEMES = {
  dark: {
    canvas: '#0a0a0c',
    // The pane is a translucent sheet over the canvas rather than an opaque
    // fill, which is what lets the bloom underneath show through it.
    glassTop: 'rgba(255,255,255,.075)',
    glassBottom: 'rgba(255,255,255,.022)',
    rim: 'rgba(255,255,255,.09)',
    rimLit: 'rgba(255,255,255,.34)',
    specular: 'rgba(255,255,255,.10)',
    shadow: '#000000',
    shadowOpacity: 0.85,
    well: 'rgba(0,0,0,.45)',
    wellRim: 'rgba(255,255,255,.05)',
    fg: '#f2f2f7',
    body: '#d0d0d6',
    muted: '#a1a1a8',
    dim: '#75757c',
    hairline: '#2c2c30',
    fill: 'rgba(255,255,255,.05)',
    fillRim: 'rgba(255,255,255,.09)',
    // The bloom exists to give the glass something to bend and to keep large
    // flat areas from going dead. It carries the ramp's hue at a tenth of its
    // saturation — enough that the pane and the dial share a temperature, far
    // too little to read as a colour in its own right. Screen lifts on a
    // near-black canvas; multiply would only muddy it.
    bloom: ['rgba(150,170,255,.11)', 'rgba(125,145,235,.08)', 'rgba(105,125,215,.05)'],
    bloomBlend: 'screen',
    grain: 0.032,
    grainBlend: 'overlay',
    sweep: 'rgba(255,255,255,.06)',
    // Deep navy → ice. Even steps in CIE L* (11, 28, 47, 65, 84 — ~18 apart),
    // not eyeballed hex. Contrast ratio is the wrong metric for small adjacent
    // patches: it is dominated by the bright end, which is how a ramp can
    // measure fine while the bottom two steps, where most hours actually sit,
    // are half the size of the top one. Hue rises with lightness rather than
    // staying fixed, so the ramp still separates for a viewer who cannot see
    // the blue at all — it has to survive being read as greyscale.
    ramp: ['#1a1d2c', '#383f6b', '#5c6ab3', '#8b99dc', '#c6cff7'],
    cellRim: 'rgba(255,255,255,.035)',
    // Language hexes are fixed and cannot adapt to the canvas. The light theme's
    // problem is pale fills dissolving into it, the dark theme's is dark ones —
    // so each gets the opposite ring.
    swatchRim: 'rgba(255,255,255,.16)',
  },
  light: {
    canvas: '#fbfbfd',
    glassTop: 'rgba(255,255,255,.72)',
    glassBottom: 'rgba(255,255,255,.44)',
    // In light mode a pane reads as glass through its rim and shadow, not its
    // fill — white on white is invisible, so the rim has to carry it.
    rim: 'rgba(0,0,0,.13)',
    rimLit: 'rgba(255,255,255,.95)',
    specular: 'rgba(255,255,255,.85)',
    shadow: '#3c3c43',
    shadowOpacity: 0.22,
    well: 'rgba(0,0,0,.035)',
    wellRim: 'rgba(0,0,0,.05)',
    fg: '#1d1d1f',
    body: '#3a3a3e',
    muted: '#6e6e73',
    dim: '#8e8e93',
    hairline: '#d8d8de',
    fill: 'rgba(0,0,0,.045)',
    fillRim: 'rgba(0,0,0,.08)',
    bloom: ['rgba(58,66,110,.10)', 'rgba(58,66,110,.07)', 'rgba(58,66,110,.05)'],
    bloomBlend: 'multiply',
    grain: 0.018,
    grainBlend: 'multiply',
    sweep: 'rgba(31,35,40,.05)',
    // The same ramp read the other way up: on a near-white canvas an empty hour
    // has to be the palest step, so this runs pale periwinkle → deep indigo.
    // L* 91, 73, 55, 38, 21 — the dark theme's spacing, mirrored.
    ramp: ['#e0e4f5', '#a9b1dc', '#7280c2', '#45529a', '#262f5e'],
    cellRim: 'rgba(0,0,0,.06)',
    swatchRim: 'rgba(0,0,0,.20)',
  },
};

// ---------------------------------------------------------------- svg helpers

const SANS_STACK = "'Mona Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO_STACK = "'Mona Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Applied to every value that reaches markup. Quotes are escaped in both
// flavours so the same helper is safe in text nodes and in attributes. Control
// characters are dropped first: XML 1.0 has no way to represent them, escaped or
// not, so one arriving in an API-supplied language name would leave behind an
// SVG no renderer will parse.
const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
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

// Concentric radii, following Apple's rule that an inner corner equals its
// parent's minus the padding between them, so nested rounds stay optically
// parallel. Panels use R_LG; wells recessed into them round to their own height.
const R_LG = 22;

// Bleed room outside the pane so it can cast a real shadow. A card that sits
// flush to the edge of its own image cannot float, and floating is most of what
// separates this material from a rectangle with a border drawn on it. Panel
// layout is unchanged: doc() grows the viewBox and translates the whole body,
// so every coordinate below is still measured against the pane, not the image.
const MARGIN = 24;

/**
 * The liquid-glass pane every panel sits in.
 *
 * backdrop-filter is meaningless here — an SVG rendered as an <img> has no
 * backdrop to blur — so the material is built in layers instead: bloom beneath
 * a translucent sheet, a specular bloom where the light lands, grain over the
 * whole thing, and a gradient rim. The rim is the detail that matters most: a
 * flat 1px stroke reads as a drawn outline, while a real edge catches light
 * unevenly, so it is a gradient running from lit through base to nothing.
 */
function pane(t, h, { bloom = true } = {}) {
  const blooms = bloom
    ? t.bloom
        .map((c, i) => {
          const cx = [0.14, 0.78, 0.45][i] * W;
          const cy = [0.1, 0.62, 1.05][i] * h;
          const rx = [0.42, 0.36, 0.34][i] * W;
          return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${(rx * 0.62).toFixed(0)}" fill="url(#bloom${i})"/>`;
        })
        .join('\n      ')
    : '';

  // A radial gradient is already a perfect falloff, so these need no blur
  // filter — only the per-theme blend that keeps them luminance, not tint.
  const bloomDefs = bloom
    ? t.bloom
        .map(
          (c, i) => `<radialGradient id="bloom${i}">
      <stop offset="0" stop-color="${c}"/>
      <stop offset="1" stop-color="${c}" stop-opacity="0"/>
    </radialGradient>`,
        )
        .join('\n    ')
    : '';

  return {
    defs: `<linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.glassTop}"/>
      <stop offset="1" stop-color="${t.glassBottom}"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2=".55" y2="1">
      <stop offset="0" stop-color="${t.rimLit}"/>
      <stop offset=".38" stop-color="${t.rim}"/>
      <stop offset=".72" stop-color="${t.rim}" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="specular" cx=".18" cy="0" r=".8">
      <stop offset="0" stop-color="${t.specular}"/>
      <stop offset="1" stop-color="${t.specular}" stop-opacity="0"/>
    </radialGradient>
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
    <filter id="lift" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="${t.shadow}" flood-opacity="${t.shadowOpacity}"/>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" stitchTiles="stitch"/>
    </filter>
    <clipPath id="pane"><rect x="0" y="0" width="${W}" height="${h}" rx="${R_LG}"/></clipPath>`,
    // The canvas rect carries the shadow and is opaque; everything above it is
    // translucent and stacks into the material.
    body: `<rect x="0" y="0" width="${W}" height="${h}" rx="${R_LG}" fill="${t.canvas}" filter="url(#lift)"/>
  <g clip-path="url(#pane)">
    <g style="mix-blend-mode:${t.bloomBlend}">
      ${blooms}
    </g>
    <rect x="0" y="0" width="${W}" height="${h}" fill="url(#surface)"/>
    <rect x="0" y="0" width="${W}" height="${(h * 0.62).toFixed(0)}" fill="url(#specular)" opacity=".5"/>
    <rect class="sweep" x="-${W * 0.5}" y="0" width="${W * 0.5}" height="${h}" fill="url(#sweep)"/>
    <rect x="0" y="0" width="${W}" height="${h}" filter="url(#grain)" opacity="${t.grain}" style="mix-blend-mode:${t.grainBlend}"/>
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="${R_LG - 0.5}" fill="none" stroke="url(#rim)"/>`,
  };
}

/**
 * Wraps a panel body into a finished document.
 *
 * The viewBox is MARGIN larger than the pane on every side and the body is
 * translated into it, which is what gives the drop shadow somewhere to land.
 * Panel code never sees this: it lays out against 0,0 → W,h as before.
 */
function doc(t, h, fontCss, defs, body, title) {
  const vw = W + MARGIN * 2;
  const vh = h + MARGIN * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}" role="img" aria-label="${esc(title)}" font-family="${esc(SANS_STACK)}">
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
      /* The radar is driven by SMIL, which no media query can pause — so the
         element is removed instead. Nothing is lost: it carries no data. */
      .radar{display:none}
    }
  </style>
  <g transform="translate(${MARGIN},${MARGIN})">
${body}
  </g>
</svg>
`;
}

const label = (t, x, y, text) =>
  `<text x="${x}" y="${y}" font-family="${esc(MONO_STACK)}" font-size="11" letter-spacing="1.6" fill="${t.dim}">${esc(text.toUpperCase())}</text>`;

/**
 * A recessed well: the surface things sit *in* rather than *on*.
 *
 * SVG has no inset box-shadow, so the depth is drawn — a darker fill, a rim,
 * and a one-pixel light catching the top inner edge, which is the cue that
 * reads as "below the surface" rather than "a darker rectangle".
 */
const well = (t, x, y, w, h, r) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${t.well}"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${t.wellRim}"/>
  <path d="M ${x + r} ${y + 1} H ${x + w - r}" stroke="${t.rimLit}" stroke-width="1" fill="none" opacity=".28"/>`;

// ------------------------------------------------------------------- clock
// A polar heatmap of when commits actually land: seven concentric rings, Monday
// innermost, each cut into twenty-four hour sectors with midnight at the top.
//
// The reason it is a dial and not another grid is that the thing it measures is
// genuinely circular. 23:00 and 01:00 are two hours apart, and every rectangular
// calendar in existence draws them at opposite ends of a row — which is exactly
// where a late-night working pattern goes to hide. Wrapped around a circle the
// same data reads as one continuous block, and the shape of a working day
// becomes something you can see at a glance rather than something you infer.

const RAD = Math.PI / 180;

const CX = 250;
const CY = 228;
const R_OUT = 150;
const R_IN = 58;
const HUB = 54;
const RINGS = 7;
const PITCH = (R_OUT - R_IN) / RINGS;
const RING_GAP = 1.7;
const SECTOR = 360 / 24;
const SECTOR_GAP = 1.2;

// Midnight at the top, clockwise, each hour centred on its sector rather than
// starting at it — the same convention every clock face on earth uses.
const angleAt = (hour) => hour * SECTOR - 90 - SECTOR / 2;
const polar = (r, deg) => [CX + r * Math.cos(deg * RAD), CY + r * Math.sin(deg * RAD)];

/** One annular sector. Sweeps are always under 180°, so the large-arc flag is fixed. */
function wedge(r0, r1, a0, a1) {
  const f = (n) => n.toFixed(2);
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return `M${f(x0)} ${f(y0)}A${f(r1)} ${f(r1)} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${f(r0)} ${f(r0)} 0 0 0 ${f(x3)} ${f(y3)}Z`;
}

const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;

function clockSVG(t, fontCss, r) {
  const H = 424;
  const p = pane(t, H);

  // A recessed annulus behind the rings, for the same reason the calendar sat in
  // a well: the bottom step of the ramp is only just lighter than the canvas, so
  // without a darker ground under it an empty hour is indistinguishable from no
  // hour at all — and the dial reads as a sparse fan rather than a full day.
  const ground = `<circle cx="${CX}" cy="${CY}" r="${(R_IN + R_OUT) / 2}" fill="none" stroke="${t.well}" stroke-width="${R_OUT - R_IN}"/>
  <circle cx="${CX}" cy="${CY}" r="${R_OUT}" fill="none" stroke="${t.wellRim}"/>
  <circle cx="${CX}" cy="${CY}" r="${R_IN}" fill="none" stroke="${t.wellRim}"/>`;

  // Levels are ranked across the whole grid at once, not per ring: a Sunday that
  // is quiet compared to a Tuesday should look quiet, and re-ranking each ring
  // against itself would flatten exactly the difference the dial exists to show.
  const flat = r.grid.flat();
  const levels = levelsFor(flat);

  const cells = [];
  for (let d = 0; d < RINGS; d += 1) {
    const r0 = R_IN + d * PITCH + RING_GAP / 2;
    const r1 = r0 + PITCH - RING_GAP;
    for (let h = 0; h < 24; h += 1) {
      const a0 = angleAt(h) + SECTOR_GAP / 2;
      const a1 = a0 + SECTOR - SECTOR_GAP;
      const level = levels[d * 24 + h];
      cells.push(
        `<path class="cell" d="${wedge(r0, r1, a0, a1)}" fill="${t.ramp[level]}" stroke="${t.cellRim}" stroke-width=".5" style="animation-delay:${h * 16}ms"/>`,
      );
    }
  }

  // Radar sweep. SMIL rather than a CSS keyframe because rotate() needs an origin
  // in this group's own user space, and transform-origin resolves against the
  // viewport — which the MARGIN translate has already moved out from under it.
  // Three stacked wedges at low alpha stand in for the angular falloff SVG has no
  // gradient for; the hairline is the leading edge.
  const [handX, handY0] = polar(R_IN, -90);
  const [, handY1] = polar(R_OUT, -90);
  const radar = `<g class="radar">
    ${[
      [40, 0.5],
      [22, 0.4],
      [9, 0.35],
    ]
      .map(([width, o]) => `<path d="${wedge(R_IN, R_OUT, -90 - width, -90)}" fill="${t.sweep}" opacity="${o}"/>`)
      .join('\n    ')}
    <line x1="${handX}" y1="${handY0.toFixed(1)}" x2="${handX}" y2="${handY1.toFixed(1)}" stroke="${t.rimLit}" stroke-width="1" opacity=".45"/>
    <animateTransform attributeName="transform" type="rotate" from="0 ${CX} ${CY}" to="360 ${CX} ${CY}" dur="18s" repeatCount="indefinite"/>
  </g>`;

  // Only the quarters are marked. Twenty-four numbers around a dial this size is
  // a ring of noise, and the four that matter are enough to orient by.
  const TICK_R = R_OUT + 16;
  const ticks = [
    [0, CX, CY - TICK_R - 3, 'middle'],
    [6, CX + TICK_R + 4, CY + 4, 'start'],
    [12, CX, CY + TICK_R + 12, 'middle'],
    [18, CX - TICK_R - 4, CY + 4, 'end'],
  ]
    .map(
      ([hour, x, y, anchor]) =>
        `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="${anchor}" font-family="${esc(MONO_STACK)}" font-size="11" letter-spacing="1" fill="${t.dim}">${String(hour).padStart(2, '0')}</text>`,
    )
    .join('\n  ');

  // The hub carries the sample size, so the number the whole dial is built from
  // sits at the centre of it rather than in a footnote.
  const hub = `<circle cx="${CX}" cy="${CY}" r="${HUB}" fill="${t.canvas}"/>
  <circle cx="${CX}" cy="${CY}" r="${HUB}" fill="none" stroke="${t.rim}"/>
  <path d="M ${CX - 35} ${CY - 41} A ${HUB} ${HUB} 0 0 1 ${CX + 35} ${CY - 41}" fill="none" stroke="${t.rimLit}" stroke-width="1" opacity=".3"/>
  <text x="${CX}" y="${CY + 1}" text-anchor="middle" font-family="${esc(MONO_STACK)}" font-size="23" font-weight="600" fill="${t.fg}">${esc(nf.format(r.total))}</text>
  <text x="${CX}" y="${CY + 21}" text-anchor="middle" font-family="${esc(MONO_STACK)}" font-size="9.5" letter-spacing="1.6" fill="${t.dim}">COMMITS</text>`;

  // Readout: label left, value right, hairline under. A ledger rather than a row
  // of stat tiles — it reads as a spec sheet, and it survives being narrow.
  const RX = 500;
  const RIGHT = W - PAD;
  const peakLabel = `${hhmm(r.peak.start)} – ${hhmm(r.peak.end)}`;
  const rows = [
    ['Busiest day', r.peakDay],
    ['After dark · 22–04', `${r.nightPct}%`],
    ['Hours active', `${r.hoursActive} / 24`],
    ['Window', `${nf.format(r.days)} days`],
  ];
  const ROW_TOP = 168;
  const ROW_H = 58;
  const readout = rows
    .map(([name, value], i) => {
      const y = ROW_TOP + i * ROW_H;
      return `<text x="${RX}" y="${y}" font-family="${esc(MONO_STACK)}" font-size="11" letter-spacing="1.3" fill="${t.dim}">${esc(name.toUpperCase())}</text>
  <text x="${RIGHT}" y="${y + 1}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="19" font-weight="600" fill="${t.fg}">${esc(value)}</text>
  <rect x="${RX}" y="${y + 17}" width="${RIGHT - RX}" height="1" fill="${t.hairline}" opacity=".5"/>`;
    })
    .join('\n  ');

  const KEY = 10;
  const keyY = 396;
  const keyX = RIGHT - 34 - (5 * KEY + 4 * 3);
  const legend = `<text x="${keyX - 8}" y="${keyY}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="10" fill="${t.dim}">Less</text>
  ${t.ramp
    .map(
      (fill, i) =>
        `<rect x="${keyX + i * (KEY + 3)}" y="${keyY - 9}" width="${KEY}" height="${KEY}" rx="2.5" fill="${fill}" stroke="${t.cellRim}"/>`,
    )
    .join('\n  ')}
  <text x="${RIGHT}" y="${keyY}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="10" fill="${t.dim}">More</text>`;

  const body = `  ${p.body}
  ${label(t, PAD, 46, 'Commit rhythm')}
  <text x="${W - PAD}" y="46" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">Mon inner → Sun outer · 24 sectors, midnight up · ${esc(TZ_LABEL)}</text>
  ${ground}
  <g class="live">
    ${cells.join('\n    ')}
  </g>
  ${radar}
  ${ticks}
  ${hub}
  <text x="${RX}" y="96" font-size="26" font-weight="800" letter-spacing="-.6" fill="${t.fg}">${esc(peakLabel)}</text>
  <text x="${RX}" y="118" font-family="${esc(MONO_STACK)}" font-size="12.5" fill="${t.muted}">the three hours most of it lands in</text>
  ${readout}
  ${legend}`;

  return doc(
    t,
    H,
    fontCss,
    p.defs,
    body,
    `Commit rhythm: a radial heatmap of ${nf.format(r.total)} commits over ${r.days} days by weekday and hour. ` +
      `Peak window ${peakLabel} ${TZ_LABEL}, busiest day ${r.peakDay}, ${r.nightPct} percent between 22:00 and 04:00, ` +
      `active in ${r.hoursActive} of 24 hours.`,
  );
}

// ------------------------------------------------------------------- signal
// What gets written, and what it gets written with. The language bar is the one
// aggregate GitHub never computes — per-repo breakdowns exist, an account-wide
// one does not — and the stack runs underneath it as a single typographic line
// rather than six labelled rows of pills, because the grouping was always
// self-evident and the labels cost more vertical space than they returned.

// Six categories flattened into one sequence. The order still runs languages →
// backend → frontend → data → devops → AI, so the grouping survives as rhythm
// even though the headings are gone.
const STACK_RUN = STACK.flatMap(([, items]) => items);

/**
 * Greedy wrap over the estimated advance width, since there is no text layout
 * engine here and <text> will not break a line on its own — an SVG that overflows
 * its viewBox does not scroll, it just loses the end of the sentence.
 */
function wrapRun(items, maxWidth, size) {
  const SEP = ' · ';
  const lines = [[]];
  let width = 0;
  for (const item of items) {
    const advance = sw(item, size) + (lines[lines.length - 1].length ? sw(SEP, size) : 0);
    if (lines[lines.length - 1].length && width + advance > maxWidth) {
      lines.push([item]);
      width = sw(item, size);
    } else {
      lines[lines.length - 1].push(item);
      width += advance;
    }
  }
  return lines;
}

function signalSVG(t, fontCss, data) {
  const langs = data.languages;
  // The segments already sum to 100 by construction; this only guards a bar
  // built from an empty or degenerate set.
  const shown = langs.reduce((a, l) => a + l.pct, 0) || 1;

  // Geometry uses l.pct at full precision; only l.label is ever printed. See
  // labelPercents() for why those are two different numbers.
  const pct = (l) => (l.label ?? l.pct ?? 0).toFixed(1);
  // "Other" is a bucket, not a language, so it gets the dimmest neutral rather
  // than borrowing some language's identity.
  const fillOf = (l) => l.color || t.dim;

  const barY = 100;
  const barW = W - PAD * 2;
  const barH = 12;

  let x = PAD;
  const segments = langs
    .map((l, i) => {
      const w = (l.pct / shown) * barW;
      // Every segment gets a rim, and every segment after the first a leading
      // edge in the canvas colour: Linguist hexes are fixed and two adjacent
      // languages can land close enough to read as one block without it.
      const edge =
        i > 0
          ? `\n    <rect x="${x.toFixed(2)}" y="${barY}" width="1" height="${barH}" fill="${t.canvas}" opacity=".55"/>`
          : '';
      const seg = `<rect x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w, 1).toFixed(2)}" height="${barH}" fill="${fillOf(l)}"/>${edge}`;
      x += w;
      return seg;
    })
    .join('\n    ');

  // One row of dot + name + percent, laid out left to right until it runs out.
  const keyY = barY + 40;
  let kx = PAD;
  const key = langs
    .map((l) => {
      const text = `${l.name} ${pct(l)}%`;
      const item = `<circle cx="${(kx + 4).toFixed(1)}" cy="${keyY - 4}" r="4" fill="${fillOf(l)}" stroke="${t.swatchRim}" stroke-width=".75"/>
  <text x="${(kx + 14).toFixed(1)}" y="${keyY}" font-family="${esc(MONO_STACK)}" font-size="11.5" fill="${t.muted}">${esc(text)}</text>`;
      kx += 14 + mw(text, 11.5) + 20;
      return item;
    })
    .join('\n  ');

  // The bar answers "what is the mix"; it does not answer "what does he write".
  // The lead language gets stated outright above it. The count is every distinct
  // language in the account, not the number of segments — five of those are
  // languages and the sixth is a bucket holding all the rest.
  const lead = langs[0];
  const note = `${pct(lead ?? { pct: 0 })}% of ${data.languageCount ?? langs.length} languages`;
  const headline = lead
    ? `<circle cx="${PAD + 6}" cy="${barY - 26}" r="6" fill="${fillOf(lead)}" stroke="${t.swatchRim}" stroke-width=".75"/>
  <text x="${PAD + 20}" y="${barY - 21}" font-size="21" font-weight="800" letter-spacing="-.5" fill="${t.fg}">${esc(lead.name)}</text>
  <text x="${(PAD + 30 + sw(lead.name, 21)).toFixed(1)}" y="${barY - 21}" font-family="${esc(MONO_STACK)}" font-size="13" fill="${t.muted}">${esc(note)}</text>`
    : '';

  // The stack, set as running text. Two tones inside one line: the tools at body
  // weight, the separators dimmed back so they read as punctuation rather than as
  // thirty-four more marks competing with the names.
  const RUN_SIZE = 12.5;
  const RUN_TOP = 190;
  const RUN_LEAD = 22;
  const runLines = wrapRun(STACK_RUN, W - PAD * 2, RUN_SIZE);
  const run = runLines
    .map((items, i) => {
      const spans = items
        .map(
          (item, j) =>
            `${j ? `<tspan fill="${t.dim}"> · </tspan>` : ''}<tspan fill="${t.body}">${esc(item)}</tspan>`,
        )
        .join('');
      return `<text x="${PAD}" y="${RUN_TOP + i * RUN_LEAD}" font-size="${RUN_SIZE}">${spans}</text>`;
    })
    .join('\n  ');

  const ruleY = 164;
  const H = RUN_TOP + (runLines.length - 1) * RUN_LEAD + 30;
  const p = pane(t, H);

  const body = `  ${p.body}
  ${label(t, PAD, 46, 'Surface')}
  <text x="${W - PAD}" y="46" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">by bytes across public repos</text>
  ${headline}
  ${well(t, PAD, barY, barW, barH, 6)}
  <g class="bar" clip-path="url(#barclip)">
    ${segments}
  </g>
  <rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6" fill="none" stroke="${t.swatchRim}"/>
  ${key}
  <rect x="${PAD}" y="${ruleY}" width="${W - PAD * 2}" height="1" fill="${t.hairline}" opacity=".5"/>
  ${run}`;

  const defs = `${p.defs}
    <clipPath id="barclip"><rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6"/></clipPath>`;

  return doc(
    t,
    H,
    fontCss,
    defs,
    body,
    `Language breakdown by bytes across public repos: ${langs.map((l) => `${l.name} ${pct(l)} percent`).join(', ')}. ` +
      `Stack: ${STACK_RUN.join(', ')}.`,
  );
}

// ------------------------------------------------------------------- fonts
// Each panel embeds only the weights it actually draws with. Faces are pinned
// static instances (see subset-font.py) — a variable face is ten times the size
// and every byte here is repeated in every panel that uses it.

const FACES = {
  sans400: { file: 'MonaSans.woff2', family: 'Mona Sans', weight: 400, pins: 'wght=400,wdth=100,opsz=16' },
  sans800: { file: 'MonaSans.woff2', family: 'Mona Sans', weight: 800, pins: 'wght=800,wdth=115,opsz=32' },
  mono400: { file: 'MonaSansMono.woff2', family: 'Mona Sans Mono', weight: 400, pins: 'wght=400,opsz=16' },
  mono600: { file: 'MonaSansMono.woff2', family: 'Mona Sans Mono', weight: 600, pins: 'wght=600,opsz=16' },
};

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'subset-font.py');

// CI is Ubuntu, where `python3` is the interpreter and `python` may not exist at
// all. Windows is the other way round: `python3` resolves to a Store stub that
// exits non-zero without running anything, so trying it first and taking the
// first one that answers is what makes a local render match what CI produces.
const PYTHONS = ['python3', 'python'];

async function subset(src, out, pins) {
  let last;
  for (const bin of PYTHONS) {
    try {
      // execFile, not exec: argv is passed through, never a shell string.
      return await run(bin, [HELPER, src, out, pins], { timeout: 60_000 });
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

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
        await subset(join(FONTS, face.file), out, face.pins);
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

// ------------------------------------------------------------------- readme
/**
 * Rewrites the README's asset references as `assets/name.svg?v=<hash>`.
 *
 * A committed SVG changing is not enough to make the profile show it. GitHub
 * serves README images through a cache keyed on the URL, and that URL is
 * identical before and after a refresh — so the panel keeps rendering yesterday's
 * numbers until the cache happens to expire. Appending a hash of the file's own
 * bytes gives the cache a new key at exactly the moment the panel changes, and
 * never otherwise: a rebuild that produces identical SVGs leaves the README
 * untouched, so this does not manufacture a commit every night.
 */
async function stampReadme(names) {
  let md;
  try {
    md = await readFile(README, 'utf8');
  } catch (err) {
    console.warn(`readme: not stamped (${err.message})`);
    return;
  }

  const versions = new Map();
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      // A panel that is not on disk keeps whatever key the README already has,
      // rather than taking the whole stamp down with it.
      try {
        const bytes = await readFile(join(ASSETS, `${name}.svg`));
        versions.set(name, createHash('sha256').update(bytes).digest('hex').slice(0, 10));
      } catch (err) {
        console.warn(`readme: ${name}.svg not stamped (${err.message})`);
      }
    }),
  );

  // Matches both a bare reference and one this script stamped on a previous run.
  const next = md.replace(/(assets\/)([a-z0-9-]+)(\.svg)(?:\?v=[0-9a-f]+)?/g, (whole, dir, name, ext) =>
    versions.has(name) ? `${dir}${name}${ext}?v=${versions.get(name)}` : whole,
  );

  if (next === md) {
    console.log('readme: cache keys already current');
    return;
  }
  await writeFile(README, next, 'utf8');
  console.log(`readme: restamped ${versions.size} asset references`);
}

// -------------------------------------------------------------------- main

// Every panel the README points at. Named once so --stamp-only knows the set
// without having to trust whatever happens to be sitting in assets/.
const PANELS = ['clock', 'signal'].flatMap((n) => [`${n}-dark`, `${n}-light`]);

async function main() {
  // --stamp-only reruns just the cache-key rewrite over the SVGs already on
  // disk: no network, no fonttools, no rendering. CI uses it to keep README.md
  // out of the render's hands — the job that can push re-derives the keys from
  // the checked-out script instead of committing a README the render wrote.
  if (process.argv.includes('--stamp-only')) {
    await stampReadme(PANELS);
    return;
  }

  await mkdir(ASSETS, { recursive: true });

  // Neither panel can be drawn from constants any more, so both are fetched
  // independently and each one's failure is scoped to itself. There is no mirror
  // for either: commit timestamps are not published anywhere outside the API, and
  // an account-wide language total exists nowhere at all.
  let rhythm = null;
  try {
    const commits = await commitTimesFromGraphQL();
    rhythm = summarizeRhythm(bucketCommits(commits.times), commits.days);
    console.log(`commits: ${rhythm.total} timestamps, peak ${hhmm(rhythm.peak.start)} ${TZ_LABEL}`);
  } catch (err) {
    console.warn(`commit rhythm failed: ${err.message}`);
  }

  let repoData = null;
  try {
    repoData = await fetchRepos();
    console.log(`languages: ${repoData.languageCount} distinct, ${repoData.languages.length} segments`);
  } catch (err) {
    console.warn(`languages failed: ${err.message}`);
  }

  const faces = await buildFaces();
  const written = [];

  for (const [name, theme] of Object.entries(THEMES)) {
    if (rhythm) {
      await writeFile(
        join(ASSETS, `clock-${name}.svg`),
        clockSVG(theme, css(faces, ['sans400', 'sans800', 'mono400', 'mono600']), rhythm),
        'utf8',
      );
      written.push(`clock-${name}`);
    }
    if (repoData) {
      await writeFile(
        join(ASSETS, `signal-${name}.svg`),
        signalSVG(theme, css(faces, ['sans400', 'sans800', 'mono400']), repoData),
        'utf8',
      );
      written.push(`signal-${name}`);
    }
  }

  if (!rhythm) console.warn('keeping the committed clock panels');
  if (!repoData) console.warn('keeping the committed signal panels');

  // Stamp every panel the README points at, not only the ones rewritten this
  // run — an untouched panel keeps the key it already has, and leaving it out
  // would strip the key rather than preserve it.
  await stampReadme(PANELS);

  console.log(`wrote ${written.length} of ${PANELS.length} panels`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
