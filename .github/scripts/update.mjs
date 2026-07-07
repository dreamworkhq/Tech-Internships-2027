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
  const wanted = (config.maxRows ?? 300) + 100;
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

function keepRow(row, config) {
  if (!row?.id || !row.title || !row.companyName) return false;
  if (config.titleInclude && !new RegExp(config.titleInclude, "i").test(row.title)) return false;
  if (config.titleExclude && new RegExp(config.titleExclude, "i").test(row.title)) return false;
  if (config.usOnly && !looksUnitedStates(row)) return false;
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

function jobUrl(row, config, content) {
  const params = new URLSearchParams({
    utm_source: "github",
    utm_medium: "job_list",
    utm_campaign: config.utmCampaign,
  });
  if (content) params.set("utm_content", content);
  return `${SITE_BASE}/job/${row.id}?${params}`;
}

function companyUrl(row, config) {
  if (!row.companyDomain) return null;
  return `${SITE_BASE}/c/${row.companyDomain}?utm_source=github&utm_medium=company&utm_campaign=${config.utmCampaign}`;
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

function renderTable(rows, config, now) {
  const showAi = Boolean(config.showAiColumn);
  const header = ["Company", "Role", "Location", ...(showAi ? ["AI focus"] : []), "Salary", "Age", "Apply"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => " --- |").join("")}`,
  ];
  for (const row of rows) {
    const cUrl = companyUrl(row, config);
    const company = cUrl
      ? `**[${truncate(esc(row.companyName), 32)}](${cUrl})**`
      : `**${truncate(esc(row.companyName), 32)}**`;
    const role = `[${truncate(esc(row.title), 72)}](${jobUrl(row, config, "title")})`;
    const cells = [
      company,
      role,
      formatLocation(row),
      ...(showAi ? [AI_KIND_LABELS[row.aiRoleKind] ?? ""] : []),
      formatSalary(row),
      formatAge(row, now),
      `[Apply](${jobUrl(row, config, "apply")})`,
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
  const windowDays = config.windowDays ?? 7;
  const freshness = config.usedWindow
    ? `every role was first indexed in the past ${windowDays} days`
    : `these are the most recently indexed roles`;

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
    `<a href="${SITE_BASE}/research?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">Hiring research</a>`,
    `<a href="${SITE_BASE}/research/ai?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">AI Labor Index</a>`,
    `<a href="../../issues">Report a listing</a>`,
  ].join("\n  ·\n  ");

  return `<a href="${matchesUrl}"><img src="./static/img/banner.svg" alt="Dreamwork. 400,000+ live jobs, crawled daily. Matched to your resume. Applied for you." width="100%"></a>

<h1 align="center">${config.title}</h1>

<p align="center">${config.tagline}</p>

<p align="center">
  <img src="${shieldRoles}" alt="${rows.length} open roles">
  <img src="${shieldUpdated}" alt="last updated">
</p>

<p align="center">
  <a href="${matchesUrl}"><img src="./static/img/btn-matches.svg" width="200" alt="See your matches on Dreamwork"></a>
</p>

<p align="center">
  ${linkRow}
</p>

Star this repo and new roles land in your GitHub feed every day. Listings come from [Dreamwork](${matchesUrl}), which crawls 400,000+ jobs directly from company career pages.

Last updated: **${updated}**. ${rows.length} open roles listed; ${freshness}. Salary shows when the posting discloses it.

${config.legend ? `${config.legend}\n` : ""}${toc ? `\n${toc}` : ""}
<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->

Rather not scan a table? [Dreamwork](${matchesUrl}) matches your resume against every role in this list and can apply for you. The free tier shows all your matches.

## More daily lists

${siblings}
- [Dreamwork Research, live hiring data](${SITE_BASE}/research?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})
- [AI Labor Index](${SITE_BASE}/research/ai?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})

## FAQ

${faq}

## How this list is built

A [GitHub Action](.github/workflows/update.yml) runs once a day. It queries Dreamwork's public listings API, filters for ${config.keywords}, removes duplicates, and rewrites this README. The raw snapshot lives in [\`data/listings.json\`](data/listings.json). Listings are crawled directly from company career pages and ATS boards (Greenhouse, Lever, Ashby, Workday, and others), so links go to real, currently open postings. Found a bad listing? [Open an issue](../../issues).
`;
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
        url: jobUrl(row, config, "json"),
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

// Display set: everything first indexed inside the rolling window (capped),
// falling back to the freshest N when the window is too thin to look alive.
const deduped = dedupe(all);
const windowDays = config.windowDays ?? 7;
const cutoff = now.getTime() - windowDays * 86400000;
const inWindow = deduped.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
const minWindowRows = config.minWindowRows ?? 100;
config.usedWindow = inWindow.length >= minWindowRows;
const rows = config.usedWindow
  ? inWindow.slice(0, config.maxRows ?? 300)
  : deduped.slice(0, minWindowRows);

if (rows.length < (config.minRows ?? 10)) {
  throw new Error(
    `Only ${rows.length} rows after filtering; refusing to overwrite the list (minRows=${config.minRows ?? 10}).`,
  );
}

mkdirSync(join(out, "data"), { recursive: true });
writeFileSync(join(out, "README.md"), renderReadme(rows, config, now));
writeFileSync(join(out, "data", "listings.json"), renderJson(rows, config, now));
console.log(
  `${config.repo}: wrote ${rows.length} rows (window=${config.usedWindow}, ${totalMatching} matching upstream) to ${out}`,
);
