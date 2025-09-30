#!/usr/bin/env node
/**
 * cin-dl : Cinemana Downloader CLI.
 *
 * Copyright (c) 2025 Sajjad Asaad (Jood)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import pLimit from "p-limit";
import pRetry from "p-retry";
import cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";
import sanitize from "sanitize-filename";
import { spawn } from "child_process";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================================
 * 🔧 Environment defaults & helpers
 * ============================================ */
const ENV = {
  BASE_URL: (process.env.BASE_URL || "").replace(/\/+$/, ""),
  OUTPUT_DIR: process.env.OUTPUT_DIR || "downloads",
  DEFAULT_QUALITY: process.env.DEFAULT_QUALITY || "mp4-1080",
  CONCURRENCY: Number(process.env.CONCURRENCY || 4),
  LOG_LEVEL: (process.env.LOG_LEVEL || "info").toLowerCase(),
  RETRY_COUNT: Number(process.env.RETRY_COUNT || 3),
  TIMEOUT: Number(process.env.TIMEOUT || 60), // seconds
  SAVE_METADATA: String(process.env.SAVE_METADATA || "true").toLowerCase() === "true",
  OVERWRITE: String(process.env.OVERWRITE || "false").toLowerCase() === "true",
  SERIES_EP_ENDPOINT: process.env.SERIES_EP_ENDPOINT || null,
  SERIES_EP_SEASON_PARAM: process.env.SERIES_EP_SEASON_PARAM || null,
  DISCOVER_LANGS: process.env.DISCOVER_LANGS || "ar,en",
  DISCOVER_LEVELS: process.env.DISCOVER_LEVELS || "0,1,2,3",
  USER_AGENT: process.env.USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
};

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function loggerFactory(level) {
  const cur = LOG_LEVELS[level] ?? 2;
  const stamp = () => new Date().toISOString();
  return {
    error: (...a) => cur >= 0 && console.error(`[${stamp()}] \x1b[31mERROR\x1b[0m`, ...a),
    warn:  (...a) => cur >= 1 && console.warn(`[${stamp()}] \x1b[33mWARN \x1b[0m`, ...a),
    info:  (...a) => cur >= 2 && console.log(`[${stamp()}] \x1b[36mINFO \x1b[0m`, ...a),
    debug: (...a) => cur >= 3 && console.log(`[${stamp()}] \x1b[2mDEBUG\x1b[0m`, ...a)
  };
}
const log = loggerFactory(ENV.LOG_LEVEL);

/* ============================================
 * 🧰 CLI
 * ============================================ */
const argv = yargs(hideBin(process.argv))
  .option("base-url", {
    type: "string",
    default: ENV.BASE_URL,
    describe: "API base, e.g., https://cinemana.shabakaty.com/api",
    demandOption: !ENV.BASE_URL
  })
  .option("output", {
    type: "string",
    default: ENV.OUTPUT_DIR,
    describe: "Output folder"
  })
  .option("movie", {
    type: "array",
    describe: "Movie/Episode ID(s) to download (repeatable)"
  })
  .option("from-video", {
    type: "array",
    describe: "Episode id(s) → discover & download FULL series they belong to"
  })
  .option("series", {
    type: "array",
    describe: "Root series ID(s) to download (discovers all episodes automatically)"
  })
  .option("season", {
    type: "array",
    describe: "Optional season filter(s) used with --from-video / --series (e.g., --season 1 --season 3)"
  })
  .option("ids-file", {
    type: "string",
    describe: "Text file with IDs (one per line; # for comments)"
  })
  .option("quality", {
    type: "string",
    default: ENV.DEFAULT_QUALITY,
    describe: "Preferred quality name (e.g., mp4-1080, mp4-720, m480)"
  })
  .option("concurrency", {
    type: "number",
    default: ENV.CONCURRENCY,
    describe: "Concurrent downloads across IDs"
  })
  .option("skip-existing", {
    type: "boolean",
    default: !ENV.OVERWRITE,
    describe: "Skip if target file exists (size not verified)"
  })
  .option("overwrite", {
    type: "boolean",
    default: ENV.OVERWRITE,
    describe: "Force overwrite existing files"
  })
  .option("mux-subs", {
    type: "boolean",
    default: false,
    describe: "Attach subtitles into MKV without re-encode (requires ffmpeg)"
  })
  .option("burn-subs", {
    type: "boolean",
    default: false,
    describe: "Burn first subtitle into video (re-encode, requires ffmpeg)"
  })
  .option("ffmpeg", {
    type: "string",
    default: process.env.FFMPEG_PATH || "ffmpeg",
    describe: "Path to ffmpeg binary"
  })
  .option("structure", {
    type: "string",
    default: "flat",
    choices: ["flat", "series"],
    describe: 'Output layout: "flat" or "series" (Show/Sxx/...)'
  })
  .option("subs", {
    type: "string",
    describe: "Comma-separated subtitle languages to download (e.g., ar,en). Default: all available"
  })
  .option("subs-format", {
    type: "string",
    default: "both",
    choices: ["srt", "vtt", "both"],
    describe: "Preferred subtitle format when multiple available"
  })
  .option("dry-run", {
    type: "boolean",
    default: false,
    describe: "Plan only: print what would be downloaded and exit"
  })
  .option("name-template", {
    type: "string",
    default: "{title}.{quality}",
    describe: "Filename template (no extension). Vars: {title},{quality},{season},{episode}"
  })
  .option("progress", {
    type: "string",
    default: "auto",
    choices: ["auto", "none"],
    describe: "Progress display mode"
  })
  .option("no-cache", {
    type: "boolean",
    default: false,
    describe: "Disable series discovery cache"
  })
  .help()
  .strict()
  .argv;

/* ============================================
 * 🌐 HTTP client
 * ============================================ */
const http = axios.create({
  baseURL: argv["base-url"],
  timeout: ENV.TIMEOUT * 1000,
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400,
  headers: {
    "User-Agent": ENV.USER_AGENT,
    "Accept": "application/json, text/plain, */*"
  }
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    // Normalize network errors for p-retry clarity
    const code = err.code || (err.response && `HTTP_${err.response.status}`) || "UNKNOWN";
    const msg = err.message || "Request failed";
    const e = new Error(`${code}: ${msg}`);
    e.code = code;
    throw e;
  }
);

/* ============================================
 * 📡 API calls
 * ============================================ */
async function getAllVideoInfo(id) {
  const { data } = await http.get(`/android/allVideoInfo/id/${id}`);
  return data;
}

async function getTranscodedFiles(id) {
  const { data } = await http.get(`/android/transcoddedFiles/id/${id}`);
  return Array.isArray(data) ? data : [];
}

async function getTranslationFiles(id) {
  const { data } = await http.get(`/android/translationFiles/id/${id}`);
  return data;
}

async function getVideoSeason(id) {
  const { data } = await http.get(`/android/videoSeason/id/${id}`);
  return Array.isArray(data) ? data : [];
}

async function getEpisodesBySeries(seriesId, seasonFilter = null) {
  const tpl = ENV.SERIES_EP_ENDPOINT; // e.g., /android/seriesEpisodes/id/{seriesId}
  if (!tpl) return null;
  let url = tpl.replace("{seriesId}", encodeURIComponent(seriesId));
  const seasonParam = ENV.SERIES_EP_SEASON_PARAM || null;
  if (seasonParam && seasonFilter) {
    const qs = new URLSearchParams({ [seasonParam]: String(seasonFilter) }).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  const { data } = await http.get(url);
  return data;
}

async function getVideoGroups(lang, level) {
  const { data } = await http.get(`/android/videoGroups/lang/${lang}/level/${level}`);
  return data?.groups || [];
}

/* ============================================
 * 🧩 Helpers
 * ============================================ */
function pad2(n) {
  const s = String(n ?? "").trim();
  return s ? s.padStart(2, "0") : null;
}

function chooseBaseTitle(info) {
  return (
    info?.en_title?.trim() ||
    info?.ar_title?.trim() ||
    info?.other_title?.trim() ||
    "untitled"
  );
}

function buildTitle(info) {
  const base = sanitize(chooseBaseTitle(info));
  const isSeries = String(info?.kind || "") === "2";
  const s = pad2(info?.season);
  const e = pad2(info?.episodeNummer);
  if (isSeries && s && e) return `${base}.S${s}E${e}`;
  return base;
}

function pickQuality(qualities, preferredName) {
  if (!Array.isArray(qualities) || qualities.length === 0) return null;
  const exact = qualities.find(q => q?.name === preferredName);
  if (exact) return exact;
  const resNum = (q) => {
    const m = String(q?.resolution || "").match(/(\d+)\s*p/i);
    return m ? Number(m[1]) : -1;
  };
  return [...qualities].sort((a, b) => resNum(a) - resNum(b)).pop();
}

function extFromUrl(url, def = ".mp4") {
  const u = url.toLowerCase();
  for (const e of [".mp4", ".mkv", ".webm", ".mov", ".m4v"]) {
    if (u.includes(e)) return e;
  }
  return def;
}

function subExt(url) {
  const u = url.toLowerCase();
  if (u.includes(".srt")) return ".srt";
  if (u.includes(".vtt")) return ".vtt";
  return ".srt";
}

function parseExpiryEpoch(url) {
  try {
    const q = new URL(url).searchParams;
    const exp = q.get("Expires");
    return exp ? Number(exp) : null;
  } catch {
    return null;
  }
}

function isExpiringSoon(epoch, minutes = 10) {
  if (!epoch) return false;
  const now = Math.floor(Date.now() / 1000);
  return epoch - now <= minutes * 60;
}

function safeUnlink(fp) {
  try { fs.unlinkSync(fp); } catch {}
}

/* ---- file naming ---- */
function buildNameFromTemplate(tpl, vars) {
  return tpl
    .replaceAll("{title}", vars.title)
    .replaceAll("{quality}", vars.quality)
    .replaceAll("{season}", vars.season ?? "")
    .replaceAll("{episode}", vars.episode ?? "");
}

/* ---- subtitles filter ---- */
function filterSubtitleTracks(tracks, langCsv, formatPref) {
  if (!Array.isArray(tracks)) return [];
  const wantLangs = langCsv
    ? new Set(langCsv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean))
    : null;

  const byLang = new Map();
  for (const t of tracks) {
    const url = t?.file;
    if (!url || /defaultImages\/loading\.gif/i.test(url)) continue;
    const lang = (t?.type || t?.name || "sub").toLowerCase();
    if (wantLangs && !wantLangs.has(lang)) continue;
    const ext = subExt(url).slice(1);
    const list = byLang.get(lang) || [];
    list.push({ url, lang, ext });
    byLang.set(lang, list);
  }

  const result = [];
  for (const [lang, list] of byLang.entries()) {
    if (formatPref === "both") result.push(...list);
    else result.push(list.find(x => x.ext === formatPref) || list[0]);
  }
  return result;
}

/* ============================================
 * 💾 Atomic downloads + progress
 * ============================================ */
function makeBar(filePath, total) {
  if (argv.progress === "none") return null;
  const bar = new cliProgress.SingleBar(
    { format: `${path.basename(filePath)} | {bar} | {percentage}% | {value}/{total}`, barCompleteChar: "█", barIncompleteChar: "░" },
    cliProgress.Presets.shades_classic
  );
  if (total > 0) bar.start(total, 0, { total: prettyBytes(total), value: "0 B" });
  return bar;
}

async function streamDownloadAtomic(url, finalPath, { skipExisting, overwrite }) {
  if (fs.existsSync(finalPath)) {
    if (overwrite) safeUnlink(finalPath);
    else if (skipExisting) return; // keep existing file
  }

  const tmpPath = `${finalPath}.part`;
  safeUnlink(tmpPath);

  const { data, headers } = await http.get(url, { responseType: "stream" });
  const total = Number(headers["content-length"] || 0);
  const bar = makeBar(finalPath, total);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpPath);
    let downloaded = 0;
    data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (bar && total > 0) bar.update(downloaded, { value: prettyBytes(downloaded) });
    });
    data.on("error", (err) => { bar?.stop(); reject(err); });
    ws.on("error", (err) => { bar?.stop(); reject(err); });
    ws.on("finish", () => { bar?.stop(); resolve(); });
    data.pipe(ws);
  });

  fs.renameSync(tmpPath, finalPath);
}

async function downloadWithRetry(url, filePath, opts) {
  await pRetry(() => streamDownloadAtomic(url, filePath, opts), {
    retries: Math.max(0, ENV.RETRY_COUNT),
    factor: 2,
    minTimeout: 800,
    maxTimeout: 4000,
    onFailedAttempt: (e) => log.warn(`Retry ${e.attemptNumber}/${e.retriesLeft + e.attemptNumber} for ${path.basename(filePath)}: ${e.message}`)
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(argv.ffmpeg, args, { stdio: "inherit" });
    proc.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with code ${code}`)); });
  });
}

async function muxSubs(videoPath, subPaths) {
  const out = videoPath.replace(/\.[^.]+$/, "") + ".muxed.mkv";
  const args = ["-y", "-i", videoPath];
  for (const sp of subPaths) args.push("-i", sp);
  // map up to 4 subtitles safely
  args.push("-map", "0", "-map", "1?", "-map", "2?", "-map", "3?", "-map", "4?", "-c", "copy", out);
  await runFfmpeg(args);
  return out;
}

async function burnFirstSub(videoPath, subPath) {
  const out = videoPath.replace(/\.[^.]+$/, "") + ".burned.mp4";
  // escape subtitle path for ffmpeg filter
  const safeSub = subPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\\'");
  const args = ["-y", "-i", videoPath, "-vf", `subtitles='${safeSub}'`, "-c:a", "copy", out];
  await runFfmpeg(args);
  return out;
}

/* ============================================
 * 🔎 Series discovery (+ simple cache)
 * ============================================ */
const CACHE_PATH = path.join(process.cwd(), ".cin-dl-cache.json");
function loadCache() {
  if (argv["no-cache"]) return { series: {} };
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { return { series: {} }; }
}
function saveCache(cache) {
  if (argv["no-cache"]) return;
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); } catch {}
}

function normalizeEpisodeIds(list) {
  return (list || []).map(e => String(e?.id ?? e?.nb ?? e)).filter(Boolean);
}

function normalizeVideoSeasonItems(items, seasonFilters) {
  const want = (season) => !seasonFilters || seasonFilters.length === 0 ? true : seasonFilters.map(String).includes(String(season ?? ""));
  return (items || [])
    .filter(it => String(it?.kind || "") === "2")
    .filter(it => want(it?.season))
    .map(it => ({
      id: String(it?.nb ?? "").trim(),
      season: Number(it?.season ?? 0),
      episode: Number(it?.episodeNummer ?? 0),
      rootSeries: String(it?.rootSeries ?? "")
    }))
    .filter(it => it.id)
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
    .map(x => x.id);
}

async function discoverEpisodesByEndpoint(seriesId, seasonFilters) {
  const episodes = [];
  if (seasonFilters && seasonFilters.length > 0 && ENV.SERIES_EP_SEASON_PARAM) {
    for (const s of seasonFilters) {
      const data = await getEpisodesBySeries(seriesId, s);
      if (data) episodes.push(...normalizeEpisodeIds(data));
    }
  } else {
    const data = await getEpisodesBySeries(seriesId, null);
    if (data) episodes.push(...normalizeEpisodeIds(data));
  }
  return [...new Set(episodes)];
}

async function discoverEpisodesByVideoGroups(seriesId, seasonFilters) {
  const langs = ENV.DISCOVER_LANGS.split(",").map(s => s.trim()).filter(Boolean);
  const levels = ENV.DISCOVER_LEVELS.split(",").map(s => s.trim()).filter(Boolean);

  const found = new Map();
  for (const lang of langs) {
    for (const level of levels) {
      try {
        const groups = await getVideoGroups(lang, level);
        for (const g of groups) {
          for (const c of (g?.content || [])) {
            if (String(c?.kind || "") !== "2") continue;
            if (String(c?.rootSeries || "") !== String(seriesId)) continue;
            const id = String(c?.nb || "");
            if (!id) continue;
            const season = Number(c?.season ?? 0);
            if (seasonFilters && seasonFilters.length && !seasonFilters.map(String).includes(String(season))) continue;
            if (!found.has(id)) found.set(id, { id, season: Number(c?.season ?? 0), episode: Number(c?.episodeNummer ?? 0) });
          }
        }
      } catch (e) {
        log.debug(`videoGroups failed for lang=${lang} level=${level}: ${e.message}`);
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.season - b.season) || (a.episode - b.episode)).map(x => x.id);
}

async function expandSeriesToEpisodeIds(seriesIds, seasonFilters) {
  const cache = loadCache();
  const out = [];
  for (const sidRaw of seriesIds) {
    const sid = String(sidRaw);
    if (cache.series?.[sid]?.episodes && !argv["no-cache"]) {
      log.info(`Using cache for series ${sid} → ${cache.series[sid].episodes.length} ep(s).`);
      out.push(...cache.series[sid].episodes);
      continue;
    }

    let eps = [];

    try {
      const vs = await getVideoSeason(sid);
      const viaVS = normalizeVideoSeasonItems(vs, seasonFilters);
      if (viaVS.length) {
        eps = viaVS;
        log.info(`Discovered ${eps.length} episode(s) for series ${sid} via videoSeason.`);
      }
    } catch (e) { log.debug(`videoSeason failed for ${sid}: ${e.message}`); }

    if (!eps || eps.length === 0) {
      try {
        const viaCfg = await discoverEpisodesByEndpoint(sid, seasonFilters);
        if (viaCfg.length) {
          eps = viaCfg;
          log.info(`Discovered ${eps.length} episode(s) for series ${sid} via configured endpoint.`);
        }
      } catch (e) { log.debug(`configured endpoint failed for ${sid}: ${e.message}`); }
    }

    if (!eps || eps.length === 0) {
      const crawl = await discoverEpisodesByVideoGroups(sid, seasonFilters);
      eps = crawl;
      if (eps.length) log.info(`Discovered ${eps.length} episode(s) for series ${sid} via videoGroups.`);
    }

    if (eps.length === 0) {
      log.warn(`No episodes discovered for series ${sid}.`);
    }

    out.push(...eps);
    cache.series[sid] = { updatedAt: new Date().toISOString(), episodes: [...new Set(eps)] };
  }
  saveCache(cache);
  return [...new Set(out)];
}

/* ============================================
 * 🎬 Core pipeline for one ID
 * ============================================ */
async function processMovie(id, cfg) {
  log.info(`\n== Movie/Episode ${id} ==`);
  const info = await getAllVideoInfo(id);

  const baseTitle = chooseBaseTitle(info);
  const smartTitle = buildTitle(info);

  const season = pad2(info?.season);
  const episode = pad2(info?.episodeNummer);
  const isSeries = String(info?.kind || "") === "2";

  const qualities = await getTranscodedFiles(id);
  if (!qualities || qualities.length === 0) {
    log.warn(`No transcoded files for ${id}. Skipping.`);
    return { id, status: "no-qualities" };
  }
  const chosen = pickQuality(qualities, cfg.quality);
  if (!chosen?.videoUrl) {
    log.warn(`No usable quality for ${id}. Skipping.`);
    return { id, status: "no-quality-url" };
  }

  const videoUrl = chosen.videoUrl;
  const qname = chosen.name || chosen.resolution || "video";
  const vext  = extFromUrl(videoUrl, ".mp4");

  const expEpoch = parseExpiryEpoch(videoUrl);
  if (isExpiringSoon(expEpoch)) {
    const mins = Math.max(0, Math.round((expEpoch - Math.floor(Date.now()/1000)) / 60));
    log.warn(`Video URL for ${id} expires in ~${mins} min; download starting...`);
  }

  // directory structure
  let targetDir = cfg.output;
  if (argv.structure === "series" && isSeries) {
    const showName = sanitize(baseTitle);
    const s = season || "00";
    targetDir = path.join(cfg.output, showName, `S${s}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // filename from template
  const nameCore = buildNameFromTemplate(argv["name-template"], {
    title: smartTitle,
    quality: qname,
    season: season || "",
    episode: episode || ""
  });
  const vname = `${nameCore}${vext}`;
  const vpath = path.join(targetDir, vname);

  if (argv["dry-run"]) {
    console.log(`PLAN: ${vname}`);
  } else {
    await downloadWithRetry(videoUrl, vpath, { skipExisting: cfg.skipExisting, overwrite: cfg.overwrite });
  }

  // subtitles
  const subsResp = await getTranslationFiles(id);
  const tracksRaw = Array.isArray(subsResp?.translations) ? subsResp.translations : [];
  const filtered = filterSubtitleTracks(tracksRaw, argv.subs, argv["subs-format"]);
  if (filtered.length === 0) log.info("No matching subtitles.");

  const subPaths = [];
  for (const t of filtered) {
    const sext = "." + t.ext;
    const sname = `${nameCore}.${t.lang}${sext}`;
    const spath = path.join(targetDir, sname);
    const sExp = parseExpiryEpoch(t.url);
    if (isExpiringSoon(sExp)) {
      const mins = Math.max(0, Math.round((sExp - Math.floor(Date.now()/1000)) / 60));
      log.warn(`Subtitle (${t.lang}) URL expires in ~${mins} min`);
    }
    if (argv["dry-run"]) {
      console.log(`PLAN: ${sname}`);
    } else {
      await downloadWithRetry(t.url, spath, { skipExisting: cfg.skipExisting, overwrite: cfg.overwrite });
      subPaths.push(spath);
    }
  }

  // metadata
  if (!argv["dry-run"] && ENV.SAVE_METADATA) {
    try {
      const meta = {
        id,
        title: smartTitle,
        baseTitle,
        season: info?.season ?? null,
        episode: info?.episodeNummer ?? null,
        kind: info?.kind ?? null,
        quality: qname,
        videoPath: vpath,
        createdAt: new Date().toISOString(),
        api: { allVideoInfo: info, chosenQuality: chosen }
      };
      fs.writeFileSync(path.join(targetDir, `${nameCore}.json`), JSON.stringify(meta, null, 2));
    } catch (e) {
      log.warn(`Failed to write metadata: ${e.message}`);
    }
  }

  if (!argv["dry-run"]) {
    if (cfg.burnSubs && subPaths.length > 0) {
      try { const out = await burnFirstSub(vpath, subPaths[0]); log.info(`Burned -> ${out}`); }
      catch (e) { log.error(`Burn failed: ${e.message}`); }
    }
    if (cfg.muxSubs && subPaths.length > 0) {
      try { const out = await muxSubs(vpath, subPaths); log.info(`Muxed -> ${out}`); }
      catch (e) { log.error(`Mux failed: ${e.message}`); }
    }
    log.info(`Done: ${smartTitle}`);
  }

  return { id, status: "ok", title: smartTitle, outDir: targetDir, file: vpath };
}

/* ============================================
 * 🧭 Input parsing & main orchestration
 * ============================================ */
function readIdsFile(fp) {
  const out = [];
  const raw = fs.readFileSync(fp, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out.push(trimmed);
  }
  return out;
}

function uniqStrings(arr) {
  return [...new Set(arr.map(String))];
}

function installSigintGuard(cancel) {
  let stopping = false;
  const onSig = () => {
    if (stopping) return; // second Ctrl+C lets Node exit naturally
    stopping = true;
    console.log("\nReceived SIGINT. Finishing in-flight jobs, cancelling the rest...");
    cancel();
  };
  process.on("SIGINT", onSig);
}

async function main() {
  const output = path.resolve(argv.output);
  fs.mkdirSync(output, { recursive: true });

  // collect explicit episode IDs
  let ids = [];
  if (argv.movie && argv.movie.length) ids.push(...argv.movie.map(String));
  if (argv["ids-file"]) ids.push(...readIdsFile(argv["ids-file"]));

  // expand "from-video" to full series via videoSeason
  if (argv["from-video"] && argv["from-video"].length) {
    const seasonFilters = argv.season ? argv.season.map(String) : null;
    const all = [];
    for (const ep of argv["from-video"].map(String)) {
      try {
        const vs = await getVideoSeason(ep);
        const expanded = normalizeVideoSeasonItems(vs, seasonFilters);
        if (expanded.length) {
          console.log(`From episode ${ep}: discovered ${expanded.length} episode(s) via videoSeason.`);
          all.push(...expanded);
        } else {
          console.warn(`No episodes discovered via videoSeason for starting episode ${ep}.`);
        }
      } catch (e) {
        console.warn(`videoSeason failed for ${ep}: ${e.message}`);
      }
    }
    ids.push(...all);
  }

  // expand series to episode IDs
  if (argv.series && argv.series.length) {
    const seasonFilters = argv.season ? argv.season.map(String) : null;
    const eps = await expandSeriesToEpisodeIds(argv.series.map(String), seasonFilters);
    ids.push(...eps);
  }

  ids = uniqStrings(ids);

  if (ids.length === 0) {
    console.error("Provide --movie <id>, --ids-file <path>, --from-video <episodeId>, or --series <rootSeriesId>.");
    process.exit(1);
  }

  const cfg = {
    output,
    quality: argv.quality,
    skipExisting: argv["skip-existing"],
    overwrite: argv["overwrite"],
    muxSubs: argv["mux-subs"],
    burnSubs: argv["burn-subs"]
  };

  const limit = pLimit(Number(argv.concurrency));

  let cancelRequested = false;
  installSigintGuard(() => { cancelRequested = true; });

  const results = [];
  const jobs = ids.map((id) => limit(async () => {
    if (cancelRequested) return; // skip queued jobs
    try {
      const r = await pRetry(() => processMovie(id, cfg), { retries: 2, factor: 2 });
      if (r) results.push(r);
    } catch (e) {
      console.error(`Error processing ${id}: ${e.message}`);
      results.push({ id, status: "error", error: e.message });
    }
  }));

  try {
    await Promise.all(jobs);
  } catch (e) {
    // Already logged per-job
  }

  // Summary
  const ok = results.filter(r => r?.status === "ok").length;
  const skipped = results.filter(r => r?.status && r.status.startsWith("no-")).length;
  const errors = results.filter(r => r?.status === "error").length;
  console.log("\n===== SUMMARY =====");
  console.log(`OK: ${ok} | Skipped: ${skipped} | Errors: ${errors} | Total: ${results.length}`);
  if (errors) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
