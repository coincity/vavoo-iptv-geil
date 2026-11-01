"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { CATALOG_URL, fetchChannels } = require("../lib/geil.cjs");

const GROUP = "Spain";
const M3U_FILE = path.join(__dirname, "..", "iptv.m3u");
const EPG_FILE = path.join(__dirname, "..", "epg.xml");

// Upstream free TR EPG (gzipped XMLTV). Matched to Vavoo channels by fuzzy name.
const EPG_UPSTREAM_URL =
  process.env.EPG_UPSTREAM_URL ||
  "https://epgshare01.online/epgshare01/epg_ripper_ES1.xml.gz";

// Optional directory of iptv-org/epg grab outputs (XMLTV per site).
// Provided by CI when the grab step runs; overrides epgshare01 when a channel is present.
const IPTVORG_GRAB_DIR = process.env.IPTVORG_GRAB_DIR || "";

// iptv-org public metadata for channel logos (name/alt_names → logo url).
const IPTVORG_CHANNELS_URL =
  process.env.IPTVORG_CHANNELS_URL ||
  "https://iptv-org.github.io/api/channels.json";
const IPTVORG_LOGOS_URL =
  process.env.IPTVORG_LOGOS_URL || "https://iptv-org.github.io/api/logos.json";

// Cloudflare Workers proxy base (no trailing slash). Set via GitHub Actions variable.
const PROXY_BASE = (process.env.PROXY_BASE || "").replace(/\/+$/, "");

// Where players should fetch the generated XMLTV EPG.
const EPG_URL =
  process.env.EPG_URL ||
  "https://raw.githubusercontent.com/coincity/vavoo-iptv-geil/main/epg.xml";

// -- categorization --------------------------------------------------------

// Strip "4K TR:" prefix, quality tags and .b/.c/.s source suffixes for matching
// only — the displayed name is unchanged.
function normalizeForCategory(name) {
  let s = String(name || "")
    .replace(/^\s*4K TR:\s*/i, "")
    .replace(/\s+(?:UHD|FHD|HD\+|HD|SD|HEVC|RAW|H265|H\.265|FEED)(?=\s|$)/gi, " ")
    .replace(/\s*\.(?:b|c|s)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Vavoo often strips Turkish characters (İ, Ü, Ç, Ş, Ğ, Ö), leaving single-letter
  // fragments like "T RK" (TÜRK), "AK T" (AKİT), "BENG T RK" (BENGÜTÜRK),
  // "S NEMA" (SİNEMA), "M N KA" (MİNİKA), "OCUK" (ÇOCUK). Restore common
  // patterns so category regexes can match them.
  s = s
    .replace(/\bT[ÜU]RK\b/gi, "TURK");

  return s;
}

// Rules are evaluated top-to-bottom. First match wins, so specific rules
// (Çocuk, Spor, Belgesel) come before broad ones (Ulusal, Yerel). niños, deporte, documental
const CATEGORY_RULES = [
  {
    name: "Infantil",
    re: /CARTOON|BOOMERANG|DISNEY|NICK(?:ELODEON|TOONS|JR|JUNIOR|\b)|BABY ?TV|BABYTV|CLAN|MONTAG/i,
  },
  {
    name: "Documentales",
    re: /DISCOVERY|NATIONAL GEOGRAPHIC|NAT ?GEO|\bHISTORY\b|\bHISTORIA\b|ANIMAL PLANET|ODISEA|CRIME|INVESTIGATION|WILD|\bTLC\b/i,
  },
  {
    name: "Deportes",
    re: /BEIN SPO[RT]{0,3}S?|\bBEIN 1\b|S[- ]?SPORTS?|\bS SPORT\b|\bLIGA\b|VAMOS|EUROSPORT|\bDEPORTES\b|\bSPOR\b|\bSPORT\b/i,
  },

];

function categorize(name) {
  const s = normalizeForCategory(name);
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(s)) return rule.name;
  }
  return "Otros";
}

// -- M3U -------------------------------------------------------------------

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/"/g, "'");
}

function sanitizeName(name) {
  return String(name ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function toStreamUrl(item) {
  const id = item?.ids?.id;
  if (PROXY_BASE && id) return `${PROXY_BASE}/play/${id}`;
  return item.url;
}

function toM3U(items, vavooToEpgId, logoResolver) {
  const header = `#EXTM3U url-tvg="${escapeAttr(EPG_URL)}" x-tvg-url="${escapeAttr(EPG_URL)}"`;
  const lines = [header];
  for (const it of items) {
    if (!it || !it.url) continue;
    const vavooId = it.ids?.id ?? "";
    const name = sanitizeName(it.name);
    if (!name) continue;
    const logo = resolveLogo(name, it.logo, logoResolver);
    const group = categorize(name);
    // Route tvg-id to the upstream EPG channel id when we have a match,
    // so TiviMate can bind the guide. Fallback to the Vavoo id.
    const tvgId = (vavooToEpgId && vavooToEpgId.get(vavooId)) || vavooId;
    lines.push(
      `#EXTINF:-1 tvg-id="${escapeAttr(tvgId)}" tvg-name="${escapeAttr(name)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(group)}",${name}`
    );
    lines.push(toStreamUrl(it));
  }
  lines.push("");
  return lines.join("\n");
}

// iptv-org logo > Vavoo logo > "" (empty). Vavoo mostly returns "" anyway.
function resolveLogo(name, vavooLogo, logoResolver) {
  if (logoResolver) {
    const l = logoResolver(name);
    if (l) return l;
  }
  return vavooLogo || "";
}

// -- XMLTV EPG -------------------------------------------------------------

function xmlEscape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&apos;"
  );
}

function xmltvTime(sec) {
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

// -- Upstream EPG (epgshare01 etc.) ----------------------------------------

async function fetchUpstreamXmltv(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`upstream EPG HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGz =
    url.toLowerCase().endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b);
  const bytes = isGz ? zlib.gunzipSync(buf) : buf;
  return bytes.toString("utf8");
}

// Load and merge all XMLTV files inside a directory (iptv-org grab output).
async function loadGrabDir(dir) {
  const combined = { channels: new Map(), progByChannel: new Map() };
  if (!dir) return combined;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return combined;
  }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith(".xml")) continue;
    let xml;
    try {
      xml = await fs.readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const parsed = parseXmltv(xml);
    for (const [id, data] of parsed.channels) {
      if (!combined.channels.has(id)) combined.channels.set(id, data);
    }
    for (const p of parsed.programmes) {
      if (!combined.progByChannel.has(p.channel))
        combined.progByChannel.set(p.channel, []);
      combined.progByChannel.get(p.channel).push(p);
    }
  }
  return combined;
}

// Parse XMLTV via regex (no dependency). Sufficient for well-formed feeds.
function parseXmltv(xml) {
  const channels = new Map(); // id -> { names[], icon }
  const programmes = []; // { start, stop, channel, titleXml, descXml, categoryXml }

  const chRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  for (const m of xml.matchAll(chRe)) {
    const id = m[1];
    const body = m[2];
    const names = [
      ...body.matchAll(/<display-name[^>]*>([^<]+)<\/display-name>/gi),
    ]
      .map((n) => n[1].trim())
      .filter(Boolean);
    const icon = body.match(/<icon\s+src="([^"]+)"/i)?.[1] || "";
    channels.set(id, { names, icon });
  }

  const prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/gi;
  for (const m of xml.matchAll(prRe)) {
    const attrs = m[1];
    const body = m[2];
    const start = attrs.match(/start="([^"]+)"/i)?.[1];
    const stop = attrs.match(/stop="([^"]+)"/i)?.[1];
    const channel = attrs.match(/channel="([^"]+)"/i)?.[1];
    if (!start || !stop || !channel) continue;
    programmes.push({ start, stop, channel, body: body.trim() });
  }

  return { channels, programmes };
}

// Loose ASCII normalization used ONLY for cross-source name matching.
function normalizeForMatch(name) {
  let s = String(name || "")
    .toUpperCase()
    .replace(/^\s*4K ES:\s*/i, "")
    .replace(/\s*\.(?:B|C|S)\b/gi, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^\)]*\)/g, " ");
  s = s
    .replace(/[İI]/g, "I")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

function normalizeStripQuality(s) {
  return s
    .replace(/\b(?:UHD|FHD|HD\+|HD|SD|HEVC|RAW|H265|4K|8K|FEED|LIVE|BACKUP)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMatchIndex(upstreamChannels) {
  const idx = new Map();
  for (const [id, data] of upstreamChannels) {
    for (const raw of data.names) {
      const k1 = normalizeForMatch(raw);
      const k2 = normalizeStripQuality(k1);
      if (k1 && !idx.has(k1)) idx.set(k1, id);
      if (k2 && !idx.has(k2)) idx.set(k2, id);
    }
  }
  return idx;
}

function matchUpstreamId(vavooName, idx) {
  const k1 = normalizeForMatch(vavooName);
  if (idx.has(k1)) return idx.get(k1);
  const k2 = normalizeStripQuality(k1);
  if (idx.has(k2)) return idx.get(k2);
  return null;
}

function toXMLTV(
  items,
  vavooToEpgId,
  idSource,
  grabChannels,
  grabProgByChannel,
  upstreamChannels,
  upstreamProgByChannel,
  logoResolver
) {
  const seenChannel = new Set();
  const channels = [];
  const programmes = [];

  for (const it of items) {
    const vavooId = it?.ids?.id;
    if (!vavooId) continue;
    const name = sanitizeName(it.name);
    if (!name) continue;

    const routedId = vavooToEpgId.get(vavooId) || vavooId;
    if (seenChannel.has(routedId)) continue;
    seenChannel.add(routedId);

    const src = idSource.get(routedId) || "inline";
    let sourceCh = null;
    let sourceProgs = [];
    if (src === "grab") {
      sourceCh = grabChannels.get(routedId) || null;
      sourceProgs = grabProgByChannel.get(routedId) || [];
    } else if (src === "epgshare01") {
      sourceCh = upstreamChannels.get(routedId) || null;
      sourceProgs = upstreamProgByChannel.get(routedId) || [];
    }

    const displayName = sourceCh?.names?.[0] || name;
    // Logo priority: iptv-org > EPG source icon > Vavoo logo > empty
    const iptvorgLogo = logoResolver ? logoResolver(name) : "";
    const icon = iptvorgLogo || sourceCh?.icon || it.logo || "";
    const iconTag = icon ? `\n    <icon src="${xmlEscape(icon)}"/>` : "";
    channels.push(
      `  <channel id="${xmlEscape(routedId)}">\n` +
      `    <display-name>${xmlEscape(displayName)}</display-name>${iconTag}\n` +
      `  </channel>`
    );

    if (sourceProgs.length > 0) {
      for (const p of sourceProgs) {
        programmes.push(
          `  <programme start="${xmlEscape(p.start)}" stop="${xmlEscape(p.stop)}" channel="${xmlEscape(routedId)}">\n    ${p.body}\n  </programme>`
        );
      }
    } else if (Array.isArray(it.epg)) {
      for (const p of it.epg) {
        if (!p || typeof p.start !== "number" || typeof p.stop !== "number")
          continue;
        const title = String(p.name ?? "").trim();
        if (!title) continue;
        programmes.push(
          `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${xmlEscape(routedId)}">\n    <title>${xmlEscape(title)}</title>\n  </programme>`
        );
      }
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="vavoo-iptv" generator-info-url="https://github.com/coincity/vavoo-iptv-geil">\n` +
    `${channels.join("\n")}\n` +
    `${programmes.join("\n")}\n` +
    `</tv>\n`
  );
}

// -- iptv-org logo index ---------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function buildLogoIndex() {
  const [channels, logos] = await Promise.all([
    fetchJson(IPTVORG_CHANNELS_URL),
    fetchJson(IPTVORG_LOGOS_URL),
  ]);
  const trChannels = channels.filter((c) => c && c.country === "ES");
  const trIds = new Set(trChannels.map((c) => c.id));

  // Prefer in_use=true logos; fall back to first available.
  const chosen = new Map();
  for (const l of logos) {
    if (!l || !trIds.has(l.channel) || !l.url) continue;
    const current = chosen.get(l.channel);
    if (!current || (l.in_use && !current.in_use)) {
      chosen.set(l.channel, l);
    }
  }

  const idx = new Map();
  for (const c of trChannels) {
    const l = chosen.get(c.id);
    if (!l) continue;
    const names = [c.name, ...(Array.isArray(c.alt_names) ? c.alt_names : [])];
    for (const n of names) {
      if (!n) continue;
      const k1 = normalizeForMatch(n);
      const k2 = normalizeStripQuality(k1);
      if (k1 && !idx.has(k1)) idx.set(k1, l.url);
      if (k2 && !idx.has(k2)) idx.set(k2, l.url);
    }
  }
  return idx;
}

function makeLogoResolver(idx) {
  if (!idx || idx.size === 0) return null;
  return (vavooName) => {
    const k1 = normalizeForMatch(vavooName);
    if (idx.has(k1)) return idx.get(k1);
    const k2 = normalizeStripQuality(k1);
    if (idx.has(k2)) return idx.get(k2);
    return "";
  };
}

async function main() {
  console.log(`Fetching group="${GROUP}" from ${CATALOG_URL} ...`);
  if (PROXY_BASE) {
    console.log(`Using PROXY_BASE=${PROXY_BASE}`);
  } else {
    console.warn(
      "WARNING: PROXY_BASE is empty. Geil page URLs will be written; use the Worker for playback."
    );
  }
  console.log(`EPG URL (published): ${EPG_URL}`);
  console.log(`EPG UPSTREAM (source): ${EPG_UPSTREAM_URL}`);

  const items = await fetchChannels();
  console.log(`Total items: ${items.length}`);

  // Deterministic order for clean git diffs
  items.sort((a, b) => {
    const an = String(a.name ?? "").toLocaleLowerCase("es-ES");
    const bn = String(b.name ?? "").toLocaleLowerCase("es-ES");
    if (an < bn) return -1;
    if (an > bn) return 1;
    const ai = a.ids?.id ?? "";
    const bi = b.ids?.id ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  let upstreamChannels = new Map();
  let upstreamProgByChannel = new Map();
  try {
    const xml = await fetchUpstreamXmltv(EPG_UPSTREAM_URL);
    const parsed = parseXmltv(xml);
    upstreamChannels = parsed.channels;
    for (const p of parsed.programmes) {
      if (!upstreamProgByChannel.has(p.channel))
        upstreamProgByChannel.set(p.channel, []);
      upstreamProgByChannel.get(p.channel).push(p);
    }
    console.log(
      `Upstream EPG (epgshare01): ${upstreamChannels.size} channels, ${parsed.programmes.length} programmes`
    );
  } catch (err) {
    console.warn(
      `Upstream EPG unavailable (${err.message}); falling back to Geil inline EPG.`
    );
  }

  const grab = await loadGrabDir(IPTVORG_GRAB_DIR);
  if (grab.channels.size > 0) {
    const grabProgCount = [...grab.progByChannel.values()].reduce(
      (s, a) => s + a.length,
      0
    );
    console.log(
      `iptv-org grab: ${grab.channels.size} channels, ${grabProgCount} programmes (dir: ${IPTVORG_GRAB_DIR})`
    );
  } else if (IPTVORG_GRAB_DIR) {
    console.warn(
      `iptv-org grab dir "${IPTVORG_GRAB_DIR}" empty or missing; only epgshare01 + Geil inline will be used.`
    );
  }

  let logoIdx = new Map();
  try {
    logoIdx = await buildLogoIndex();
    console.log(`Logo index: ${logoIdx.size} name keys → iptv-org ES logos`);
  } catch (err) {
    console.warn(`Logo index unavailable (${err.message}); logos will be empty.`);
  }
  const logoResolver = makeLogoResolver(logoIdx);

  const grabIdx = buildMatchIndex(grab.channels);
  const upstreamIdx = buildMatchIndex(upstreamChannels);
  const vavooToEpgId = new Map();
  const idSource = new Map();
  let grabMatched = 0;
  let upstreamMatched = 0;
  let logoMatched = 0;
  for (const it of items) {
    const vavooId = it?.ids?.id;
    if (!vavooId) continue;
    const name = sanitizeName(it.name);
    if (!name) continue;

    // Priority: iptv-org grab (real TR descriptions) > epgshare01 (title-only) > Geil inline
    const grabId = matchUpstreamId(name, grabIdx);
    if (grabId) {
      vavooToEpgId.set(vavooId, grabId);
      idSource.set(grabId, "grab");
      grabMatched++;
    } else {
      const upstreamId = matchUpstreamId(name, upstreamIdx);
      if (upstreamId) {
        vavooToEpgId.set(vavooId, upstreamId);
        idSource.set(upstreamId, "epgshare01");
        upstreamMatched++;
      } else {
        vavooToEpgId.set(vavooId, vavooId);
      }
    }
    if (logoResolver && logoResolver(name)) logoMatched++;
  }
  console.log(
    `Channel binding: grab=${grabMatched}, epgshare01=${upstreamMatched}, geil-only=${items.length - grabMatched - upstreamMatched} (total ${items.length})`
  );
  console.log(
    `Logo binding:    ${logoMatched}/${items.length} Geil channels matched an iptv-org logo`
  );

  const m3u = toM3U(items, vavooToEpgId, logoResolver);
  await fs.writeFile(M3U_FILE, m3u, "utf8");
  console.log(`Wrote ${M3U_FILE} (${m3u.length} bytes, ${items.length} channels)`);

  const epg = toXMLTV(
    items,
    vavooToEpgId,
    idSource,
    grab.channels,
    grab.progByChannel,
    upstreamChannels,
    upstreamProgByChannel,
    logoResolver
  );
  await fs.writeFile(EPG_FILE, epg, "utf8");
  const programmeCount = (epg.match(/<programme /g) || []).length;
  const channelCount = (epg.match(/<channel /g) || []).length;
  console.log(
    `Wrote ${EPG_FILE} (${epg.length} bytes, ${channelCount} channels, ${programmeCount} programmes)`
  );

  const dist = new Map();
  for (const it of items) {
    const name = sanitizeName(it?.name);
    if (!name) continue;
    const c = categorize(name);
    dist.set(c, (dist.get(c) || 0) + 1);
  }
  console.log("\nCategory distribution:");
  for (const [c, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(10)}: ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
