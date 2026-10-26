'use strict';
// Cinemana + Cee addon server (Stremio protocol: catalog + meta + stream).
// Both sites use the same API, so one server exposes two separate addons:
//   /cinemana/manifest.json      (ids  cinemana:123)
//   /cee/manifest.json           (ids  cee:123)
// The old root address /manifest.json still answers as Cinemana.
// Zero dependencies. Needs Node 18+ (built-in fetch).
//
// IMPORTANT: both sites only open from Iraq / Earthlink. This server must run
// on a connection that can open them (phone with Termux, home PC, or a host
// inside Iraq). A host outside Iraq (Render, Vercel...) will show empty lists.

const http = require('http');

const PORT = parseInt(process.env.PORT, 10) || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const PREFER_EN = process.env.TITLE_LANG === 'en'; // TITLE_LANG=en -> English titles first

const PAGE_SIZE = 30;
const SEARCH_PAGE_SIZE = 12;
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const SITES = {
  cinemana: {
    key: 'cinemana',
    label: 'سينمانا',
    api: (process.env.CINEMANA_BASE || 'https://cinemana.shabakaty.cc').replace(/\/+$/, '') + '/api/android',
    sorts: [
      ['new', 'desc', 'الأحدث رفعاً'],
      ['release', 'r_desc', 'الأحدث إصداراً'],
      ['views', 'views_desc', 'الأكثر مشاهدة'],
      ['rating', 'stars_desc', 'الأعلى تقييماً IMDb'],
    ],
  },
  cee: {
    key: 'cee',
    label: 'Cee',
    api: (process.env.CEE_BASE || 'https://cee.buzz').replace(/\/+$/, '') + '/api/android',
    sorts: [
      ['new', 'desc', 'الأحدث رفعاً'],
      ['views', 'views_desc', 'الأكثر مشاهدة'],
      ['rating', 'stars_desc', 'الأعلى تقييماً IMDb'],
      ['az', 'en_title_asc', 'أبجدياً A-Z'],
    ],
  },
};

// ---------------------------------------------------------------- upstream
const cache = new Map();

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return hit.val;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    const val = await res.json();
    cache.set(url, { val, exp: Date.now() + CACHE_TTL_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return val;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- helpers
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function pickTitle(it) {
  const ar = str(it && it.ar_title);
  const en = str(it && it.en_title);
  return (PREFER_EN ? en || ar : ar || en) || 'بدون عنوان';
}

function qualityNumber(resolution) {
  const m = str(resolution).match(/(\d{3,4})/);
  if (m) return parseInt(m[1], 10);
  if (/4k/i.test(str(resolution))) return 2160;
  return 0;
}

const KINDS = {
  movie: { kind: 1, label: 'أفلام' },
  series: { kind: 2, label: 'مسلسلات' },
};

// ----------------------------------------------------------- one site = one addon
function createSite(cfg) {
  const API = cfg.api;
  const ID_PREFIX = cfg.key + ':';

  function toPreview(it, type) {
    if (!it || !it.nb) return null;
    const meta = {
      id: ID_PREFIX + it.nb,
      type,
      name: pickTitle(it),
      poster: it.imgObjUrl || it.img || undefined,
    };
    if (it.year) meta.releaseInfo = str(it.year);
    const r = parseFloat(it.stars);
    if (!isNaN(r) && r > 0) meta.imdbRating = r.toFixed(1);
    return meta;
  }

  function idToNb(id) {
    const s = str(id);
    if (s.indexOf(ID_PREFIX) !== 0) return null;
    return s.slice(ID_PREFIX.length).split(':')[0] || null;
  }

  const catalogs = [];
  const catalogMap = {};
  Object.keys(KINDS).forEach((type) => {
    cfg.sorts.forEach(([key, sort, label]) => {
      const id = cfg.key + '_' + type + '_' + key;
      catalogs.push({
        type,
        id,
        name: cfg.label + ' | ' + KINDS[type].label + ' - ' + label,
        extra: [{ name: 'skip' }],
      });
      catalogMap[id] = { type, kind: KINDS[type].kind, sort };
    });
    const sid = cfg.key + '_search_' + type;
    catalogs.push({
      type,
      id: sid,
      name: cfg.label + ' | بحث ' + KINDS[type].label,
      extra: [{ name: 'search', isRequired: true }, { name: 'skip' }],
    });
    catalogMap[sid] = { type, search: true };
  });

  const manifest = {
    id: 'community.' + cfg.key + '.iraq',
    version: '1.0.0',
    name: cfg.label + ' Iraq',
    description: 'كتالوج ' + cfg.label + ' الكامل (يعمل من شبكة العراق / إيرثلنك فقط)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: [ID_PREFIX],
    catalogs,
  };

  async function handleCatalog(type, id, extra) {
    const def = catalogMap[id];
    if (!def || def.type !== type) return { metas: [] };
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);

    let list;
    if (def.search) {
      const q = str(extra.search);
      if (!q) return { metas: [] };
      const enc = encodeURIComponent(q);
      const page = Math.floor(skip / SEARCH_PAGE_SIZE);
      list = await getJson(
        API + '/AdvancedSearch?level=0&videoTitle=' + enc + '&staffTitle=' + enc +
          '&year=1900,' + new Date().getFullYear() + '&page=' + page +
          '&type=' + (type === 'series' ? 'series' : 'movies') +
          '&itemsPerPage=' + SEARCH_PAGE_SIZE
      );
    } else {
      const page = Math.floor(skip / PAGE_SIZE);
      list = await getJson(
        API + '/video/V/2?videoKind=' + def.kind + '&langNb=&itemsPerPage=' + PAGE_SIZE +
          '&pageNumber=' + page + '&level=0&sortParam=' + def.sort
      );
    }

    const seen = {};
    const metas = (Array.isArray(list) ? list : [])
      .map((it) => toPreview(it, type))
      .filter((m) => m && !seen[m.id] && (seen[m.id] = true));
    return { metas };
  }

  async function handleMeta(type, id) {
    const nb = idToNb(id);
    if (!nb) return { meta: null };

    const d = await getJson(API + '/allVideoInfo/id/' + nb);
    if (!d || typeof d !== 'object') return { meta: null };

    const meta = {
      id: ID_PREFIX + nb,
      type,
      name: pickTitle(d),
      poster: d.imgObjUrl || d.img || undefined,
      background: d.imgObjUrl || d.img || undefined,
      description: str(d.ar_content) || str(d.en_content) || undefined,
      releaseInfo: d.year ? str(d.year) : undefined,
      genres: (Array.isArray(d.categories) ? d.categories : [])
        .map((c) => str(c.ar_title) || str(c.en_title)).filter(Boolean),
      cast: (Array.isArray(d.actorsInfo) ? d.actorsInfo : []).map((a) => str(a.name)).filter(Boolean),
      director: (Array.isArray(d.directorsInfo) ? d.directorsInfo : []).map((a) => str(a.name)).filter(Boolean),
    };
    const r = parseFloat(d.stars);
    if (!isNaN(r) && r > 0) meta.imdbRating = r.toFixed(1);
    const secs = parseFloat(d.duration);
    if (!isNaN(secs) && secs > 0) meta.runtime = Math.round(secs / 60) + ' min';

    if (type === 'series') {
      const eps = await getJson(API + '/videoSeason/id/' + nb).catch(() => []);
      const base = Date.UTC(parseInt(d.year, 10) || 2000, 0, 1);
      meta.videos = (Array.isArray(eps) ? eps : [])
        .filter((e) => e && e.nb)
        .map((e) => ({
          e,
          season: parseInt(e.season, 10) || 1,
          episode: parseInt(e.episodeNummer, 10) || 1,
        }))
        .sort((a, b) => a.season - b.season || a.episode - b.episode)
        .map((x, i) => ({
          id: ID_PREFIX + x.e.nb,
          title: 'الحلقة ' + x.episode,
          season: x.season,
          episode: x.episode,
          thumbnail: x.e.imgObjUrl || x.e.img || undefined,
          released: new Date(base + i * 86400000).toISOString(),
        }));
    }
    return { meta };
  }

  async function handleStream(type, id) {
    const nb = idToNb(id);
    if (!nb) return { streams: [] };

    const files = await getJson(API + '/transcoddedFiles/id/' + nb);
    if (!Array.isArray(files)) return { streams: [] };

    let subtitles = [];
    try {
      const d = await getJson(API + '/allVideoInfo/id/' + nb);
      const order = { vtt: 0, srt: 1, ass: 2 };
      subtitles = (Array.isArray(d && d.translations) ? d.translations : [])
        .filter((s) => s && s.file)
        .sort((a, b) => (order[str(a.extention).toLowerCase()] ?? 3) - (order[str(b.extention).toLowerCase()] ?? 3))
        .map((s, i) => ({ id: cfg.key + '-sub-' + i, url: s.file, lang: str(s.name) || 'Arabic' }));
    } catch (e) {
      /* subtitles are optional */
    }

    const streams = files
      .filter((f) => f && f.videoUrl)
      .map((f) => ({ q: qualityNumber(f.resolution), f }))
      .sort((a, b) => b.q - a.q)
      .map(({ q, f }) => {
        const label = q ? q + 'p' : str(f.resolution) || 'Auto';
        const s = {
          url: f.videoUrl,
          name: cfg.key === 'cee' ? 'Cee' : 'Cinemana',
          title: label,
          behaviorHints: { bingeGroup: cfg.key + '-' + label },
        };
        if (subtitles.length) s.subtitles = subtitles;
        return s;
      });
    return { streams };
  }

  return { cfg, manifest, handleCatalog, handleMeta, handleStream };
}

const sites = {};
Object.keys(SITES).forEach((k) => { sites[k] = createSite(SITES[k]); });

// ------------------------------------------------------------------ server
function send(res, code, body, maxAge) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': maxAge ? 'max-age=' + maxAge : 'no-cache',
  });
  res.end(JSON.stringify(body));
}

function parseExtra(raw) {
  const out = {};
  if (!raw) return out;
  raw.split('&').forEach((p) => {
    const i = p.indexOf('=');
    if (i < 0) return;
    try {
      out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
    } catch (e) {
      /* ignore bad escapes */
    }
  });
  return out;
}

const strip = (s) => s.replace(/\.json$/, '');
const dec = (s) => {
  try { return decodeURIComponent(s); } catch (e) { return s; }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    return res.end();
  }

  let parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);

  // /cinemana/... or /cee/...  (no prefix = Cinemana, the old address)
  let site = sites.cinemana;
  if (parts[0] && sites[parts[0]]) {
    site = sites[parts[0]];
    parts = parts.slice(1);
  }
  const resource = parts[0];

  try {
    if (!resource) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Cinemana + Cee addon server is running.\n/cinemana/manifest.json\n/cee/manifest.json\n');
    }
    if (resource === 'manifest.json') return send(res, 200, site.manifest, 3600);

    if (resource === 'catalog' && parts.length >= 3) {
      const type = dec(parts[1]);
      const id = dec(strip(parts[2]));
      const extra = parts[3] ? parseExtra(strip(parts[3])) : {};
      return send(res, 200, await site.handleCatalog(type, id, extra), 300);
    }
    if (resource === 'meta' && parts.length >= 3) {
      return send(res, 200, await site.handleMeta(dec(parts[1]), dec(strip(parts[2]))), 300);
    }
    if (resource === 'stream' && parts.length >= 3) {
      return send(res, 200, await site.handleStream(dec(parts[1]), dec(strip(parts[2]))));
    }
    return send(res, 404, { err: 'not found' });
  } catch (err) {
    console.log('[' + site.cfg.key + ']', req.url, '->', err && err.message ? err.message : err,
      err && err.cause ? '| cause: ' + (err.cause.code || err.cause.message) : '');
    if (resource === 'catalog') return send(res, 200, { metas: [] });
    if (resource === 'meta') return send(res, 200, { meta: null });
    if (resource === 'stream') return send(res, 200, { streams: [] });
    return send(res, 500, { err: 'server error' });
  }
});

module.exports = { server, sites };

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('Addon server running on port ' + PORT);
    console.log('Cinemana: http://127.0.0.1:' + PORT + '/cinemana/manifest.json');
    console.log('Cee:      http://127.0.0.1:' + PORT + '/cee/manifest.json');
  });
}
