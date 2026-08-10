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
import { createHash } from 'node:crypto';

const run = promisify(execFile);

const LOGIN = 'mohammadumar-dev';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const FONTS = join(ASSETS, 'fonts');
const README = join(ROOT, 'README.md');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const nf = new Intl.NumberFormat('en-US');

// ------------------------------------------------------------------- content
// The only prose on the profile. Everything else on the page is a number.

const NAME = ['Mohammad', 'Umar Shaikh'];
const BIO = 'Software engineer. Java and Spring Boot systems that stay up under load, plus production LLM tooling.';
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

/**
 * The shape check is not enough on its own: '2024-99-99' matches ISO_DAY, and
 * the calendar then lays out from `new Date(...)` of it. That is an Invalid
 * Date, whose getUTCMonth() is NaN — MONTHS[NaN] is undefined, so a malformed
 * day from the mirror would print "undefined NaN, NaN" into the panel's title
 * and range. Round-tripping through Date rejects the impossible ones.
 */
const isRealDay = (iso) => {
  if (typeof iso !== 'string' || !ISO_DAY.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso;
};

const clampInt = (value, lo, hi, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback;
};

function normalizeDays(raw, source) {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${source} returned no days`);
  if (raw.length > MAX_DAYS) throw new Error(`${source} returned ${raw.length} days, expected <= ${MAX_DAYS}`);
  return raw.map((d, i) => {
    const date = d?.date;
    if (!isRealDay(date)) {
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

/**
 * Re-levels the calendar by rank among active days rather than by GitHub's own
 * bucketing.
 *
 * GitHub scales its levels against your single busiest day, so one outlier
 * flattens everything under it — a 76-contribution day put 97% of this grid
 * into levels 0 and 1, which is why the heatmap read as two tones no matter how
 * the ramp was tuned. Ranking instead gives each level roughly a quarter of the
 * active days, so the whole ramp gets used and no single day can compress the
 * rest. It matters more here than on the site: a monochrome ramp has less to
 * separate its steps with than a green one does.
 */
function rebucket(days) {
  const active = days
    .filter((d) => d.count > 0)
    .map((d) => d.count)
    .sort((a, b) => a - b);
  // Nothing to rank: keep whatever the API said.
  if (!active.length) return days;

  const at = (p) => active[Math.floor(p * (active.length - 1))];
  const [t1, t2, t3] = [at(0.25), at(0.5), at(0.75)];

  return days.map((d) => {
    if (!Number.isFinite(d.count)) return d; // fall back to the API's level
    if (d.count <= 0) return { ...d, level: 0 };
    const level = d.count <= t1 ? 1 : d.count <= t2 ? 2 : d.count <= t3 ? 3 : 4;
    return { ...d, level };
  });
}

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

  return {
    languages: summarizeLanguages(byteTotals),
    languageCount: byteTotals.size,
    totals: {
      stars: raw.reduce((a, r) => a + (r?.fork ? 0 : clampInt(r?.stargazers_count, 0, MAX_COUNT)), 0),
      repos: owned.length,
    },
  };
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
// Monochrome graphite, lifted from portfolio.html so the profile and the site
// read as one system. Every distinction these panels make — hierarchy, state,
// emphasis — is carried by luminance and weight rather than by hue, which is
// why the steps below are wider apart than they would need to be if a colour
// were helping. The one exception is the language bar, which wears each
// language's own Linguist hex: that is borrowed identity, not decoration, and
// being the only saturated thing here is what makes it read as information.

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
    // Neutral luminance only. The bloom exists to give the glass something to
    // bend and to keep large flat areas from going dead — never to tint.
    // Screen lifts on a near-black canvas; multiply would only muddy it.
    bloom: ['rgba(235,235,245,.10)', 'rgba(210,210,225,.075)', 'rgba(190,190,205,.05)'],
    bloomBlend: 'screen',
    grain: 0.032,
    grainBlend: 'overlay',
    sweep: 'rgba(255,255,255,.06)',
    // Even steps in CIE L*, ~17 apart, not eyeballed hex. Contrast ratio is the
    // wrong metric for small adjacent patches — it is dominated by the bright
    // end, which is how a ramp can measure fine while the bottom two steps,
    // where most days actually sit, are half the size of the top one.
    ramp: ['#202225', '#4a4b4f', '#75777b', '#a4a6aa', '#dbdde1'],
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
    bloom: ['rgba(60,60,67,.10)', 'rgba(60,60,67,.07)', 'rgba(60,60,67,.05)'],
    bloomBlend: 'multiply',
    grain: 0.018,
    grainBlend: 'multiply',
    sweep: 'rgba(31,35,40,.05)',
    ramp: ['#e3e5e9', '#b7b9bd', '#8a8c8f', '#5d5e62', '#333538'],
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
// parallel. Panels use R_LG; wells recessed into them use R_SM.
const R_LG = 22;
const R_SM = 10;

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
  const mark = `${well(t, MARK_X, MARK_Y, 60, 60, 14)}
  <g class="live">${cells}</g>`;

  // Meta stacks up the right so the pane has weight on both sides instead of a
  // long dead band between the name and the rule.
  const meta = META.map(
    (line, i) =>
      `<text x="${W - PAD}" y="${60 + i * 24}" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="12.5" fill="${t.dim}">${esc(line)}</text>`,
  ).join('\n  ');

  const body = `  ${p.body}
  ${mark}
  <text x="${PAD + 78}" y="66" font-size="33" font-weight="800" letter-spacing="-1.05" fill="${t.fg}">${esc(NAME[0])}</text>
  <text x="${PAD + 78}" y="101" font-size="33" font-weight="800" letter-spacing="-1.05" fill="${t.fg}">${esc(NAME[1])}</text>
  <text x="${PAD + 79}" y="126" font-family="${esc(MONO_STACK)}" font-size="13" fill="${t.muted}">@${esc(LOGIN)}</text>
  ${meta}
  <rect x="${PAD}" y="150" width="${W - PAD * 2}" height="1" fill="url(#rule)"/>
  <rect x="${PAD}" y="168" width="3" height="18" rx="1.5" fill="${t.fg}" opacity=".55"/>
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
      return `<rect class="cell" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${t.ramp[day.level]}" stroke="${t.cellRim}" style="animation-delay:${week * 12}ms"/>`;
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
        `<rect x="${(keyX + i * (KEY + 3)).toFixed(1)}" y="${WELL_Y - 17}" width="${KEY}" height="${KEY}" rx="2.5" fill="${fill}" stroke="${t.cellRim}"/>`,
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
  ${well(t, PAD + WD, WELL_Y, wellW, +wellH.toFixed(2), R_SM)}
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

  const body = `  ${p.body}
  ${label(t, PAD, 46, 'Languages')}
  <text x="${W - PAD}" y="46" text-anchor="end" font-family="${esc(MONO_STACK)}" font-size="11" fill="${t.dim}">by bytes across public repos</text>
  ${headline}
  ${well(t, PAD, barY, barW, barH, 6)}
  <g class="bar" clip-path="url(#barclip)">
    ${segments}
  </g>
  <rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6" fill="none" stroke="${t.swatchRim}"/>`;

  const defs = `${p.defs}
    <clipPath id="barclip"><rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="6"/></clipPath>`;

  return doc(
    t,
    H,
    fontCss,
    defs,
    `${body}\n  ${key}`,
    `Language breakdown by bytes: ${langs.map((l) => `${l.name} ${pct(l)} percent`).join(', ')}`,
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
        const chip = `<rect x="${x.toFixed(1)}" y="${y - 15}" width="${w.toFixed(1)}" height="24" rx="12" fill="${t.fill}" stroke="${t.fillRim}"/>
  <text x="${(x + w / 2).toFixed(1)}" y="${y + 1}" text-anchor="middle" font-family="${esc(MONO_STACK)}" font-size="12" fill="${t.body}">${esc(item)}</text>`;
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
  // Carries the panels' horizontal margin even though it has no pane of its own.
  // Every asset is rendered at width="100%", so a rule drawn edge to edge would
  // be wider on the page than the panes above it and the column would look bent.
  const vw = W + MARGIN * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="2" viewBox="0 0 ${vw} 2" role="presentation">
  <defs>
    <linearGradient id="r" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.hairline}" stop-opacity="0"/>
      <stop offset=".5" stop-color="${t.hairline}"/>
      <stop offset="1" stop-color="${t.hairline}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="${MARGIN}" width="${W}" height="1" y="0.5" fill="url(#r)"/>
</svg>
`;
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
const PANELS = ['hero', 'pulse', 'langs', 'stack', 'rule'].flatMap((n) => [`${n}-dark`, `${n}-light`]);

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
    // Stamp every panel the README points at, not just the ones rewritten this
    // run: the untouched ones keep the hash they already have.
    await stampReadme([...written, 'pulse-dark', 'pulse-light', 'langs-dark', 'langs-light']);
    console.log(`wrote ${written.length} panels`);
    return;
  }

  // Re-level before rendering, but summarize from the original counts — the
  // streaks and totals are facts about the data, not about how it is shaded.
  const days = rebucket(contributions.days);

  const data = {
    contributions: {
      total: contributions.total,
      start: days[0].date,
      end: days[days.length - 1].date,
      ...summarize(days),
      days,
    },
    languages: repoData.languages,
    languageCount: repoData.languageCount,
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

  await stampReadme(written);

  console.log(
    `wrote ${written.length} panels — ${nf.format(data.contributions.total)} contributions, ` +
      `${data.totals.repos} repos, ${data.totals.stars} stars, ${data.languageCount} languages ` +
      `in ${data.languages.length} segments`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
