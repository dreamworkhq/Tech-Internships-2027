#!/usr/bin/env node
/**
 * Dreamwork GitHub Job-List Franchise generator (growth mission B).
 *
 * Pulls fresh listings from the public Dreamwork API and renders a README.md
 * job table plus a data/listings.json snapshot for one list repo. The same
 * file is vendored into each public list repo at .github/scripts/update.mjs
 * and driven by the config.json sitting next to it; tools/job-lists in the
 * monorepo is the source of truth (see publish.sh).
 *
 * Zero dependencies on purpose: the public repos run this on a bare
 * actions/setup-node runner with nothing installed.
 *
 * Usage: node generate.mjs <config.json> [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const API_BASE = process.env.DREAMWORK_API_BASE ?? "https://api.dreamworkhq.com";
const SITE_BASE = process.env.DREAMWORK_SITE_BASE ?? "https://www.dreamworkhq.com";
const PAGE_SIZE = 25; // anonymous plan cap on GET /listings

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR",
]);

function parseArgs(argv) {
  const [configPath, ...rest] = argv;
  if (!configPath) {
    console.error("usage: node generate.mjs <config.json> [--out <dir>]");
    process.exit(1);
  }
  let out = dirname(resolve(configPath));
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out" && rest[i + 1]) out = resolve(rest[++i]);
  }
  return { configPath: resolve(configPath), out };
}

async function fetchJson(url, attempt = 1) {
  const res = await fetch(url, {
    headers: { "user-agent": "dreamwork-job-lists/1.0 (+https://www.dreamworkhq.com)" },
  });
  if (!res.ok) {
    if (attempt < 4 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.json();
}

/** Fetch listings for one source (query-param set), newest first. */
async function fetchSource(source, config) {
  const collected = [];
  const maxPages = config.maxPagesPerSource ?? 40;
  // Inventory lists must exhaust the source; fresh lists stop once the
  // display cap (plus dedupe headroom) is covered.
  const wanted =
    config.mode === "inventory" ? Infinity : (config.maxRows ?? 600) + 150;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    for (const [k, v] of Object.entries(source)) {
      if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
    }
    const data = await fetchJson(`${API_BASE}/listings?${params}`);
    const rows = data.listings ?? [];
    for (const row of rows) {
      if (keepRow(row, config)) collected.push(row);
    }
    if (rows.length < PAGE_SIZE) break; // last page
    if (collected.length >= wanted) break;
  }
  return collected;
}

// US/non-US partitioning happens after fetch (international rows feed
// INTERNATIONAL.md), so keepRow only applies the audience filters.
function keepRow(row, config) {
  if (!row?.id || !row.title || !row.companyName) return false;
  // Staffing-agency reposts hide the employer behind "Confidential Employer"
  // or a machine-suffixed name like "Superloop 1733718881"; a public list
  // full of those reads as spam, so drop them.
  if (/\bconfidential\b/i.test(row.companyName)) return false;
  if (/\b\d{9,}\b/.test(row.companyName)) return false;
  if (config.titleInclude && !new RegExp(config.titleInclude, "i").test(row.title)) return false;
  if (config.titleExclude && new RegExp(config.titleExclude, "i").test(row.title)) return false;
  if (config.aiKinds && !config.aiKinds.includes(row.aiRoleKind)) return false;
  return true;
}

// Foreign markers that defeat the state-code heuristic: "Mumbai, IN" is India
// (not Indiana) and "IN, TN, Chennai" is Tamil Nadu (not Tennessee).
const NON_US_LOCATION = new RegExp(
  "\\b(" +
    [
      "canada|india|united kingdom|\\buk\\b|ireland|germany|france|netherlands|belgium|spain|portugal|italy|austria|switzerland|poland|romania|czech|slovakia|hungary|ukraine|sweden|norway|denmark|finland|estonia|latvia|lithuania|greece|turkey|israel|egypt|nigeria|kenya|south africa|uae|dubai|saudi|qatar|japan|china|taiwan|korea|vietnam|philippines|indonesia|malaysia|thailand|singapore|australia|new zealand|brazil|argentina|chile|colombia|peru|mexico|costa rica|guatemala",
      "london|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|mississauga|quebec|mumbai|chennai|bengaluru|bangalore|hyderabad|pune|delhi|noida|gurgaon|gurugram|kolkata|ahmedabad|dublin|berlin|munich|paris|amsterdam|warsaw|krakow|madrid|barcelona|lisbon|milan|rome|vienna|prague|budapest|bucharest|zurich|geneva|stockholm|copenhagen|oslo|helsinki|athens|istanbul|tel aviv|cairo|lagos|nairobi|johannesburg|cape town|riyadh|doha|tokyo|osaka|shanghai|beijing|shenzhen|seoul|taipei|hong kong|jakarta|kuala lumpur|bangkok|manila|ho chi minh|hanoi|sydney|melbourne|brisbane|perth|auckland|wellington|s[ãa]o paulo|buenos aires|santiago|bogot[áa]|lima|mexico city|guadalajara|monterrey",
    ].join("|") +
    ")\\b",
  "i",
);

// Unambiguous US markers for locations that carry no state code, e.g. a bare
// "Austin" or "Round Rock, Texas". Deliberately omits names that collide with
// non-US places (Cambridge, Birmingham, Durham, Aurora, Alexandria, Georgia).
const US_LOCATION = new RegExp(
  "\\b(" +
    [
      "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming",
      "nyc|brooklyn|manhattan|san francisco|los angeles|san jose|san diego|palo alto|mountain view|menlo park|sunnyvale|cupertino|santa clara|redwood city|berkeley|oakland|fremont|irvine|pasadena|burbank|el segundo|sacramento|seattle|bellevue|redmond|tacoma|spokane|portland|eugene|boise|austin|dallas|houston|fort worth|plano|frisco|san antonio|el paso|phoenix|scottsdale|tempe|chandler|tucson|las vegas|reno|salt lake city|denver|boulder|colorado springs|fort collins|chicago|milwaukee|madison|minneapolis|detroit|ann arbor|indianapolis|columbus|cleveland|cincinnati|pittsburgh|philadelphia|baltimore|bethesda|rockville|reston|mclean|arlington|boston|stamford|hartford|new haven|providence|hoboken|jersey city|buffalo|rochester|syracuse|albany|atlanta|charlotte|raleigh|chapel hill|greensboro|nashville|memphis|knoxville|chattanooga|huntsville|louisville|lexington|new orleans|baton rouge|jacksonville|orlando|tampa|miami|fort lauderdale|boca raton|st\\.? louis|kansas city|omaha|des moines|oklahoma city|tulsa|wichita|albuquerque|anchorage|honolulu",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * US detection. The public API added locationCountryCode later than this
 * script; fall back to a location-string heuristic when the field is absent.
 * (Heuristic mirrors the "Atlanta, GA is not Gabon" lesson: only trust
 * two-letter tokens that are genuinely US state codes in a state position,
 * and reject anything carrying a known foreign city/country marker first.)
 */
function looksUnitedStates(row) {
  if (row.locationCountryCode) return row.locationCountryCode === "US";
  const loc = row.location ?? "";
  if (!loc) return false;
  if (/\b(united states|usa|u\.s\.)\b/i.test(loc)) return true;
  if (NON_US_LOCATION.test(loc)) return false;
  if (/\bUS\b/.test(loc)) return true;
  if (US_LOCATION.test(loc)) return true;
  const suffix = loc.match(/,\s*([A-Z]{2})\s*(?:,|$|\()/);
  if (suffix && US_STATES.has(suffix[1])) return true;
  const prefix = loc.match(/^([A-Z]{2})\s*[-–]/);
  if (prefix && US_STATES.has(prefix[1])) return true;
  return false;
}

function dedupe(rows) {
  const byId = new Map();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  const byPosting = new Map();
  for (const row of byId.values()) {
    const key = `${row.companyName.toLowerCase().trim()}|${row.title.toLowerCase().trim()}|${(row.location ?? "").toLowerCase().trim()}`;
    const prev = byPosting.get(key);
    if (!prev || new Date(row.createdAt) > new Date(prev.createdAt)) byPosting.set(key, row);
  }
  return [...byPosting.values()].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
}

// ---------- rendering ----------

function esc(text) {
  // Escape everything that can break a markdown table cell or link label.
  return String(text)
    .replace(/[|[\]]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Row links carry only source+campaign: at inventory scale (~900 rows) every
// utm byte counts against GitHub's ~500 KiB markdown render cutoff.
function jobUrl(row, config) {
  return `${SITE_BASE}/job/${row.id}?utm_source=github&utm_campaign=${config.utmCampaign}`;
}

function companyUrl(row, config) {
  if (!row.companyDomain) return null;
  return `${SITE_BASE}/c/${row.companyDomain}?utm_source=github&utm_campaign=${config.utmCampaign}`;
}

function formatSalary(row) {
  const { salaryMin: min, salaryMax: max } = row;
  if (!min || !max || min > max) return "";
  if (min >= 15 && max <= 300) return `$${min}–$${max}/hr`;
  if (min < 20000 || max > 900000) return ""; // currency-conversion junk in corpus
  const k = (n) => `$${Math.round(n / 1000)}K`;
  return min === max ? k(min) : `${k(min)}–${k(max)}`;
}

function formatLocation(row) {
  let loc = esc(row.location ?? "");
  if (/^(anywhere|remote)$/i.test(loc)) loc = "";
  if (row.remoteType === "remote") return loc ? `Remote (${truncate(loc, 40)})` : "Remote";
  loc = truncate(loc || "—", 44);
  if (row.remoteType === "hybrid") return `${loc} (Hybrid)`;
  return loc;
}

function formatAge(row, now) {
  const seen = new Date(row.createdAt);
  const days = Math.max(0, Math.floor((now - seen) / 86400000));
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

const AI_KIND_LABELS = {
  ai_first: "AI-first",
  ai_explicit: "AI-focused",
  ai_enabled: "AI-enabled",
};

// No separate Apply column: the role link opens the Dreamwork job page,
// which is the apply path, and the duplicate URL per row would push
// inventory-size lists past GitHub's markdown render cutoff.
function renderTable(rows, config, now) {
  const showAi = Boolean(config.showAiColumn);
  const header = ["Company", "Role", "Location", ...(showAi ? ["AI focus"] : []), "Salary", "Age"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => " --- |").join("")}`,
  ];
  for (const row of rows) {
    const cUrl = companyUrl(row, config);
    const company = cUrl
      ? `**[${truncate(esc(row.companyName), 32)}](${cUrl})**`
      : `**${truncate(esc(row.companyName), 32)}**`;
    const role = `[${truncate(esc(row.title), 72)}](${jobUrl(row, config)})`;
    const cells = [
      company,
      role,
      formatLocation(row),
      ...(showAi ? [AI_KIND_LABELS[row.aiRoleKind] ?? ""] : []),
      formatSalary(row),
      formatAge(row, now),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

// GitHub's anchor algorithm: lowercase, drop punctuation, spaces to hyphens.
function anchorSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-");
}

/**
 * Group rows into sections by functionPrimary (count-descending, tiny
 * groups pooled into "Other"), Simplify-style, so a 300-row list stays
 * browsable. Returns { toc, body }.
 */
function renderSections(rows, config, now) {
  if (!config.groupBy) {
    return { toc: "", body: renderTable(rows, config, now) };
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.functionPrimary || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const named = [...groups.entries()].filter(([k, v]) => k !== "Other" && v.length >= 5);
  named.sort((a, b) => b[1].length - a[1].length);
  const leftovers = [...groups.entries()]
    .filter(([k, v]) => k === "Other" || v.length < 5)
    .flatMap(([, v]) => v)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const sections = [...named];
  if (leftovers.length > 0) sections.push(["Other", leftovers]);

  const toc = sections
    .map(([name, list]) => {
      const title = `${name} (${list.length})`;
      return `- [${name}](#${anchorSlug(title)}) · ${list.length} roles`;
    })
    .join("\n");
  const body = sections
    .map(([name, list]) => `### ${name} (${list.length})\n\n${renderTable(list, config, now)}`)
    .join("\n\n");
  return { toc: `${toc}\n`, body };
}

function renderReadme(rows, config, now) {
  const updated = now.toISOString().slice(0, 10);
  const matchesUrl = `${SITE_BASE}/?utm_source=github&utm_medium=readme_cta&utm_campaign=${config.utmCampaign}`;
  const { toc, body } = renderSections(rows, config, now);
  const inventoryScope =
    rows.length >= (config.usOpenTotal ?? rows.length)
      ? `All **${rows.length}** currently open roles are listed.`
      : `The **${rows.length}** newest of **${config.usOpenTotal}** currently open roles are listed (GitHub caps how much of a page it renders).`;
  const statsLine =
    config.mode === "inventory"
      ? `Last updated: **${updated}**. ${inventoryScope} The crawler rechecks every listing daily, so closed roles drop off automatically. Salary shows when the posting discloses it. Click a role to see details and apply.`
      : `Last updated: **${updated}**. Showing the **${rows.length}** most recently indexed roles, curated from **${(config.totalMatching ?? 0).toLocaleString("en-US")}** open listings on Dreamwork. Salary shows when the posting discloses it. Click a role to see details and apply.`;
  const intlLine = config.intlCount
    ? `\nHiring outside the US? **${config.intlCount}** international roles are listed separately in [INTERNATIONAL.md](INTERNATIONAL.md).\n`
    : "";

  const siblings = (config.siblings ?? [])
    .map((s) => `- [${s.label}](https://github.com/${s.repo})`)
    .join("\n");

  const faq = (config.faq ?? [])
    .map((f) => `<details>\n<summary><strong>${f.q}</strong></summary>\n\n${f.a}\n\n</details>`)
    .join("\n\n");

  const repoFull = `${config.owner}/${config.repo}`;
  const shieldRoles = `https://img.shields.io/badge/open_roles-${rows.length}-7C3AED?labelColor=131318&style=flat-square`;
  const shieldUpdated = `https://img.shields.io/github/last-commit/${repoFull}?label=updated&color=3B82F6&labelColor=131318&style=flat-square`;
  const linkRow = [
    `<a href="${SITE_BASE}/?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">dreamworkhq.com</a>`,
    `<a href="${SITE_BASE}/blog?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">Blog</a>`,
    `<a href="${SITE_BASE}/research?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">Hiring research</a>`,
    `<a href="../../issues">Report a listing</a>`,
  ].join("\n  ·\n  ");

  const bannerAlt = "Dreamwork turns live job listings into personalized matches";
  const ctaAlt = "Match my resume to these roles";

  return `<a href="${matchesUrl}">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/img/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./static/img/banner-light.svg">
    <img src="./static/img/banner-light.svg" alt="${bannerAlt}" width="100%">
  </picture>
</a>

<h1 align="center">${config.title}</h1>

<p align="center">${config.tagline}</p>

<p align="center">
  <img src="${shieldRoles}" alt="${rows.length} open roles">
  <img src="${shieldUpdated}" alt="last updated">
</p>

<p align="center">
  <a href="${matchesUrl}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./static/img/btn-matches-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="./static/img/btn-matches-light.svg">
      <img src="./static/img/btn-matches-light.svg" width="340" alt="${ctaAlt}">
    </picture>
  </a>
</p>

<p align="center">
  ${linkRow}
</p>

Star this repo and new roles land in your GitHub feed every day. Listings come from [Dreamwork](${matchesUrl}), which crawls 400,000+ jobs directly from company career pages.

${statsLine}
${intlLine}
${config.legend ? `${config.legend}\n` : ""}${toc ? `\n${toc}` : ""}
<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->

Rather not scan a table? [Dreamwork](${matchesUrl}) matches your resume against every role in this list and can apply for you. The free tier shows all your matches.

## More daily lists

${siblings}
- [Dreamwork Research, live hiring data](${SITE_BASE}/research?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})
- [How to use Dreamwork, guides and tutorials](${SITE_BASE}/how-to?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})

## FAQ

${faq}

## How this list is built

A [GitHub Action](.github/workflows/update.yml) runs once a day. It queries Dreamwork's public listings API, filters for ${config.keywords}, removes duplicates, and rewrites this README. The raw snapshot lives in [\`data/listings.json\`](data/listings.json). Listings are crawled directly from company career pages and ATS boards (Greenhouse, Lever, Ashby, Workday, and others), so links go to real, currently open postings. Found a bad listing? [Open an issue](../../issues).
`;
}

function renderIntl(rows, config, now) {
  const updated = now.toISOString().slice(0, 10);
  const matchesUrl = `${SITE_BASE}/?utm_source=github&utm_medium=intl_readme&utm_campaign=${config.utmCampaign}`;
  const { toc, body } = renderSections(rows, config, now);
  return `# ${config.title}: international

Roles outside the United States, from the same daily crawl as [the US list](README.md). Locations are shown per row; grouping by country will come once the public API exposes country codes.

Last updated: **${updated}**. **${rows.length}** currently open international roles. Click a role to see details and apply, or let [Dreamwork](${matchesUrl}) match them to your resume.

${toc ? `${toc}\n` : ""}<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->
`;
}

/**
 * GitHub stops rendering markdown files around 500 KiB; trim rows until the
 * rendered document fits with margin, so a growing corpus degrades to
 * "newest N" instead of an unrendered wall of text.
 */
const RENDER_LIMIT_BYTES = 460000;
function fitToRenderLimit(rows, render) {
  let n = rows.length;
  let text = render(rows);
  while (Buffer.byteLength(text) > RENDER_LIMIT_BYTES && n > 50) {
    n = Math.floor(n * 0.9);
    text = render(rows.slice(0, n));
  }
  return { text, kept: n };
}

function renderJson(rows, config, now) {
  return `${JSON.stringify(
    {
      generatedAt: now.toISOString(),
      source: "https://www.dreamworkhq.com",
      list: config.repo,
      count: rows.length,
      listings: rows.map((row) => ({
        id: row.id,
        title: row.title,
        company: row.companyName,
        companyDomain: row.companyDomain ?? null,
        location: row.location ?? null,
        remoteType: row.remoteType ?? null,
        salaryMin: row.salaryMin ?? null,
        salaryMax: row.salaryMax ?? null,
        aiRoleKind: row.aiRoleKind ?? null,
        postedAt: row.postedAt ?? null,
        firstIndexedAt: row.createdAt,
        url: jobUrl(row, config),
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------- main ----------

const { configPath, out } = parseArgs(process.argv.slice(2));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const now = new Date();

let all = [];
let totalMatching = 0;
for (const source of config.sources) {
  const params = new URLSearchParams({ limit: "1" });
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  }
  const head = await fetchJson(`${API_BASE}/listings?${params}`);
  totalMatching += head.total ?? 0;
  all = all.concat(await fetchSource(source, config));
}
config.totalMatching = totalMatching;

// Partition and pick the display set.
// inventory mode: every verified-open matching role (US in README,
// the rest in INTERNATIONAL.md). fresh mode: the newest maxRows.
const deduped = dedupe(all);
const minCoverageRatio = config.minUpstreamCoverageRatio;
if (
  config.mode === "inventory" &&
  Number.isFinite(minCoverageRatio) &&
  minCoverageRatio > 0 &&
  minCoverageRatio <= 1 &&
  totalMatching > 0 &&
  deduped.length / totalMatching < minCoverageRatio
) {
  throw new Error(
    `Upstream coverage collapsed: ${deduped.length} filtered unique rows from ${totalMatching} matching upstream (${(deduped.length / totalMatching * 100).toFixed(1)}%; minimum ${(minCoverageRatio * 100).toFixed(1)}%). Refusing to overwrite the list.`,
  );
}
const usRows = deduped.filter((r) => looksUnitedStates(r));
const intlRows = deduped.filter((r) => !looksUnitedStates(r));
let readmeRows = config.usOnly ? usRows : deduped;
if (config.mode !== "inventory") {
  readmeRows = readmeRows.slice(0, config.maxRows ?? 600);
}

config.usOpenTotal = readmeRows.length;

if (readmeRows.length < (config.minRows ?? 10)) {
  throw new Error(
    `Only ${readmeRows.length} rows after filtering; refusing to overwrite the list (minRows=${config.minRows ?? 10}).`,
  );
}

mkdirSync(join(out, "data"), { recursive: true });

let intlKept = 0;
if (config.international && intlRows.length >= 25) {
  const intl = fitToRenderLimit(intlRows, (r) => renderIntl(r, config, now));
  writeFileSync(join(out, "INTERNATIONAL.md"), intl.text);
  intlKept = intl.kept;
}
config.intlCount = intlKept;

const readme = fitToRenderLimit(readmeRows, (r) => renderReadme(r, config, now));
writeFileSync(join(out, "README.md"), readme.text);

const jsonRows = (config.usOnly ? usRows.concat(intlRows.slice(0, intlKept)) : readmeRows).slice(0, 1500);
writeFileSync(join(out, "data", "listings.json"), renderJson(jsonRows, config, now));
console.log(
  `${config.repo}: README ${readme.kept} rows (${config.mode ?? "fresh"}), intl ${intlKept}, json ${jsonRows.length}, ${totalMatching} matching upstream -> ${out}`,
);
