// Generates the profile stat cards as animated SVGs (light + dark) into ./dist.
// Runs in GitHub Actions with GITHUB_TOKEN; no third-party card service needed.
import { mkdirSync, writeFileSync } from "node:fs";

const LOGIN = process.env.PROFILE_USER || "livvaa";
const DISPLAY = process.env.PROFILE_NAME || "NADYR";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.env.OUT_DIR || "dist";
const TZ_HOURS = Number(process.env.PROFILE_TZ_OFFSET ?? 3); // Türkiye = UTC+3
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const THEMES = {
  light: { title: "#0e7c86", text: "#1f2328", muted: "#59636e", line: "#d0d7de", accent: "#0e7c86", warm: "#8a5a2b", track: "#e6eef0" },
  dark: { title: "#3fb6c0", text: "#e6edf3", muted: "#8b949e", line: "#30363d", accent: "#3fb6c0", warm: "#d49a62", track: "#1c2a2d" },
};
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const longDate = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${shortDate(iso)}, ${d.getUTCFullYear()}`; };

// ---------- data ----------
const main = await gql(`query($login:String!){
  user(login:$login){
    createdAt
    followers{totalCount}
    pullRequests{totalCount}
    issues{totalCount}
    repositoriesContributedTo(first:1, contributionTypes:[COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]){totalCount}
    repositories(first:100, ownerAffiliations:OWNER, privacy:PUBLIC, isFork:false){
      totalCount
      nodes{ stargazerCount languages(first:10, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
    }
    contributionsCollection{
      totalCommitContributions
      contributionCalendar{ totalContributions weeks{ contributionDays{ contributionCount date } } }
    }
  }
}`, { login: LOGIN });
const u = main.user;

// all-time daily contributions (one query per calendar year)
const days = new Map();
const startYear = new Date(u.createdAt).getUTCFullYear();
const now = new Date();
for (let y = startYear; y <= now.getUTCFullYear(); y++) {
  const from = new Date(Date.UTC(y, 0, 1)).toISOString();
  const to = new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();
  const d = await gql(`query($login:String!,$from:DateTime!,$to:DateTime!){ user(login:$login){ contributionsCollection(from:$from,to:$to){ contributionCalendar{ weeks{ contributionDays{ contributionCount date } } } } } }`, { login: LOGIN, from, to });
  for (const w of d.user.contributionsCollection.contributionCalendar.weeks)
    for (const day of w.contributionDays) days.set(day.date, day.contributionCount);
}
const dates = [...days.keys()].sort();
const today = new Date(now.getTime() + TZ_HOURS * 3600e3).toISOString().slice(0, 10);
const allDates = dates.filter((d) => d <= today);
const totalAll = allDates.reduce((a, d) => a + days.get(d), 0);
const firstActive = allDates.find((d) => days.get(d) > 0) || allDates[0];

// streaks
let longest = { len: 0, start: null, end: null }, run = { len: 0, start: null };
for (const d of allDates) {
  if (days.get(d) > 0) { run = run.len ? { len: run.len + 1, start: run.start } : { len: 1, start: d }; if (run.len > longest.len) longest = { len: run.len, start: run.start, end: d }; }
  else run = { len: 0, start: null };
}
let i = allDates.length - 1;
if (i >= 0 && days.get(allDates[i]) === 0) i--; // today not counted yet doesn't break the streak
let current = { len: 0, start: null, end: null };
for (; i >= 0 && days.get(allDates[i]) > 0; i--) current = { len: current.len + 1, start: allDates[i], end: current.end || allDates[i] };

// languages by bytes across public, non-fork repos
const langs = new Map();
let stars = 0;
for (const r of u.repositories.nodes) {
  stars += r.stargazerCount;
  for (const e of r.languages.edges) {
    const cur = langs.get(e.node.name) || { size: 0, color: e.node.color || "#8b949e" };
    cur.size += e.size; langs.set(e.node.name, cur);
  }
}
let langList = [...langs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.size - a.size);
const langTotal = langList.reduce((a, l) => a + l.size, 0) || 1;
if (langList.length > 6) {
  const rest = langList.slice(5).reduce((a, l) => a + l.size, 0);
  langList = [...langList.slice(0, 5), { name: "Other", size: rest, color: "#8b949e" }];
}

const weeks = u.contributionsCollection.contributionCalendar.weeks;
const lastYearTotal = u.contributionsCollection.contributionCalendar.totalContributions;

// ---------- svg helpers ----------
const wrap = (w, h, t, body, extraCss = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img">
<style>
  text { font-family: ${FONT}; }
  .title { font-size: 18px; font-weight: 600; fill: ${t.title}; }
  .lbl { font-size: 14px; fill: ${t.text}; }
  .val { font-size: 14px; font-weight: 700; fill: ${t.text}; }
  .muted { font-size: 12px; fill: ${t.muted}; }
  .rise { animation: rise .6s ease-out both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  ${extraCss}
  ${process.env.NO_ANIM ? "* { animation: none !important; }" : ""}
</style>
${body}
</svg>`;

function statsCard(t) {
  const rows = [
    ["Total stars earned", fmt(stars)],
    ["Commits (last year)", fmt(u.contributionsCollection.totalCommitContributions)],
    ["Pull requests", fmt(u.pullRequests.totalCount)],
    ["Issues", fmt(u.issues.totalCount)],
    ["Contributed to", fmt(u.repositoriesContributedTo.totalCount)],
  ];
  const W = 440, H = 195, R = 44, C = 2 * Math.PI * R;
  let body = `<text x="25" y="35" class="title rise">${esc(DISPLAY)}'s GitHub Stats</text>`;
  rows.forEach(([k, v], n) => {
    const y = 70 + n * 25;
    body += `<g class="rise" style="animation-delay:${150 + n * 120}ms"><circle cx="31" cy="${y - 5}" r="4" fill="${t.accent}"/><text x="45" y="${y}" class="lbl">${k}:</text><text x="250" y="${y}" class="val" text-anchor="end">${v}</text></g>`;
  });
  body += `<g transform="translate(345 112)">
    <circle r="${R}" stroke="${t.track}" stroke-width="7"/>
    <circle r="${R}" stroke="${t.warm}" stroke-width="7" stroke-linecap="round" transform="rotate(-90)" stroke-dasharray="${C.toFixed(1)}" class="ring"/>
    <text y="4" text-anchor="middle" class="val" style="font-size:22px">${fmt(lastYearTotal)}</text>
    <text y="24" text-anchor="middle" class="muted">past year</text>
  </g>`;
  return wrap(W, H, t, body, `.ring { stroke-dashoffset: 0; animation: ring 1.4s ease-out both; } @keyframes ring { from { stroke-dashoffset: ${C.toFixed(1)}; } to { stroke-dashoffset: 0; } }`);
}

function readable(hex, t) {
  if (t !== THEMES.dark) return hex;
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.3) return hex;
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  return "#" + [mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function langsCard(t) {
  const W = 440, H = 195, bx = 25, bw = 390;
  let body = `<text x="25" y="35" class="title rise">Most used languages</text><defs><clipPath id="bar"><rect x="${bx}" y="55" width="${bw}" height="10" rx="5"/></clipPath></defs><g clip-path="url(#bar)" class="grow">`;
  let x = bx;
  langList.forEach((l) => { const w = (l.size / langTotal) * bw; body += `<rect x="${x.toFixed(2)}" y="55" width="${(w + 0.5).toFixed(2)}" height="10" fill="${readable(l.color, t)}"/>`; x += w; });
  body += `</g>`;
  langList.forEach((l, n) => {
    const col = n % 2, row = Math.floor(n / 2), lx = 25 + col * 205, ly = 98 + row * 30;
    body += `<g class="rise" style="animation-delay:${300 + n * 110}ms"><circle cx="${lx + 5}" cy="${ly - 5}" r="5" fill="${readable(l.color, t)}"/><text x="${lx + 18}" y="${ly}" class="lbl">${esc(l.name)}</text><text x="${lx + 185}" y="${ly}" class="muted" text-anchor="end">${((l.size / langTotal) * 100).toFixed(1)}%</text></g>`;
  });
  return wrap(W, H, t, body, `.grow { transform-origin: ${bx}px 60px; animation: grow 1s ease-out both; } @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }`);
}

function streakCard(t) {
  const W = 880, H = 195, R = 40, C = 2 * Math.PI * R;
  const range = (s) => (s.len ? (s.start === s.end ? shortDate(s.start) : `${shortDate(s.start)} – ${shortDate(s.end)}`) : "No streak yet");
  let body = `<line x1="293" y1="30" x2="293" y2="165" stroke="${t.line}"/><line x1="587" y1="30" x2="587" y2="165" stroke="${t.line}"/>`;
  body += `<g class="rise"><text x="147" y="88" text-anchor="middle" class="val" style="font-size:30px;fill:${t.accent}">${fmt(totalAll)}</text><text x="147" y="122" text-anchor="middle" class="lbl">Total contributions</text><text x="147" y="146" text-anchor="middle" class="muted">${longDate(firstActive)} – Present</text></g>`;
  body += `<g transform="translate(440 70)" class="rise" style="animation-delay:200ms">
    <circle r="${R}" stroke="${t.track}" stroke-width="6"/>
    <circle r="${R}" stroke="${t.warm}" stroke-width="6" stroke-linecap="round" transform="rotate(-90)" stroke-dasharray="${C.toFixed(1)}" class="ring"/>
    <text y="10" text-anchor="middle" class="val" style="font-size:28px;fill:${t.warm}">${current.len}</text>
  </g>
  <g class="rise" style="animation-delay:300ms"><text x="440" y="140" text-anchor="middle" class="val" style="fill:${t.warm}">Current streak</text><text x="440" y="162" text-anchor="middle" class="muted">${range(current)}</text></g>`;
  body += `<g class="rise" style="animation-delay:400ms"><text x="733" y="88" text-anchor="middle" class="val" style="font-size:30px;fill:${t.accent}">${longest.len}</text><text x="733" y="122" text-anchor="middle" class="lbl">Longest streak</text><text x="733" y="146" text-anchor="middle" class="muted">${range(longest)}</text></g>`;
  return wrap(W, H, t, body, `.ring { animation: ring 1.4s .2s ease-out both; } @keyframes ring { from { stroke-dashoffset: ${C.toFixed(1)}; } to { stroke-dashoffset: 0; } }`);
}

function activityCard(t) {
  const W = 880, H = 300, L = 48, Rm = 20, T = 56, B = 40;
  const totals = weeks.map((w) => w.contributionDays.reduce((a, d) => a + d.contributionCount, 0));
  const firsts = weeks.map((w) => w.contributionDays[0].date);
  const max = Math.max(1, ...totals);
  const mag = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s * 4 >= max) || 10 * mag;
  const ymax = Math.max(step, Math.ceil(max / step) * step);
  const x = (n) => L + (n * (W - L - Rm)) / (totals.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  let body = `<text x="25" y="32" class="title rise">Contribution activity</text><text x="${W - Rm}" y="32" text-anchor="end" class="muted">contributions per week · last 12 months</text>`;
  for (let v = 0; v <= ymax; v += step)
    body += `<line x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}" stroke="${t.line}" stroke-dasharray="${v ? "3 4" : "0"}"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" class="muted">${v}</text>`;
  let lastMonth = -1;
  firsts.forEach((d, n) => {
    const m = new Date(d + "T00:00:00Z").getUTCMonth();
    if (m !== lastMonth && n > 0 && n < totals.length - 2) body += `<text x="${x(n)}" y="${H - 14}" text-anchor="middle" class="muted">${MONTHS[m]}</text>`;
    lastMonth = m;
  });
  const pts = totals.map((v, n) => [x(n), y(v)]);
  let len = 0; for (let n = 1; n < pts.length; n++) len += Math.hypot(pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1]);
  const line = pts.map((p, n) => `${n ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  body += `<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity=".35"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient></defs>`;
  body += `<path d="${line} L${x(totals.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z" fill="url(#area)" class="fade"/>`;
  body += `<path d="${line}" stroke="${t.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" class="draw"/>`;
  pts.forEach((p, n) => { if (totals[n] > 0) body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="${t.warm}" class="rise" style="animation-delay:${800 + n * 15}ms"/>`; });
  const lp = pts[pts.length - 1];
  body += `<circle cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="5" fill="${t.warm}"/><circle cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="5" stroke="${t.warm}" stroke-width="2" class="pulse"/>`;
  return wrap(W, H, t, body, `
    .draw { stroke-dasharray: ${len.toFixed(0)}; stroke-dashoffset: 0; animation: draw 1.8s ease-out both; }
    @keyframes draw { from { stroke-dashoffset: ${len.toFixed(0)}; } to { stroke-dashoffset: 0; } }
    .fade { animation: fade 1.2s .6s ease-out both; } @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 2s ease-out infinite; }
    @keyframes pulse { from { transform: scale(1); opacity: .9; } to { transform: scale(3); opacity: 0; } }`);
}

// ---------- write ----------
mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  const sfx = name === "dark" ? "-dark" : "";
  writeFileSync(`${OUT}/stats${sfx}.svg`, statsCard(t));
  writeFileSync(`${OUT}/langs${sfx}.svg`, langsCard(t));
  writeFileSync(`${OUT}/streak${sfx}.svg`, streakCard(t));
  writeFileSync(`${OUT}/activity${sfx}.svg`, activityCard(t));
}
console.log(`cards written: stars=${stars} total=${totalAll} lastYear=${lastYearTotal} current=${current.len} longest=${longest.len} langs=${langList.map((l) => l.name).join(",")}`);
