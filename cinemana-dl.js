#!/usr/bin/env node
/**
 * Cinemana downloader CLI
 * - Downloads video & subtitles by movie/episode id(s)
 * - Full-series mode via: --from-video <episodeId> or --series <rootSeriesId>
 * - Discovers episodes using:
 *   1) /android/videoSeason/id/{id}            (preferred)
 *   2) SERIES_EP_ENDPOINT (optional, via .env)
 *   3) /android/videoGroups/lang/{lang}/level/{level}  (fallback crawl, optional)
 *
 * Requires: Node 18+, ffmpeg (for --mux-subs / --burn-subs)
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

/* ============================
 * CLI
 * ============================ */
const argv = yargs(hideBin(process.argv))
    .option("base-url", {
      type: "string",
      default: (process.env.BASE_URL || "").replace(/\/+$/, ""),
      describe: "API base, e.g., https://cinemana.shabakaty.com",
      demandOption: !process.env.BASE_URL
    })
    .option("output", {
      type: "string",
      default: process.env.OUTPUT_DIR || "downloads",
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
      default: process.env.DEFAULT_QUALITY || "mp4-1080",
      describe: "Preferred quality name (e.g., mp4-1080, mp4-720, m480)"
    })
    .option("concurrency", {
      type: "number",
      default: Number(process.env.CONCURRENCY || 4),
      describe: "Concurrent downloads across IDs"
    })
    .option("skip-existing", {
      type: "boolean",
      default: false,
      describe: "Skip if target file exists (size not verified)"
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
    .help()
    .strict()
    .argv;

/* ============================
 * HTTP client
 * ============================ */
const http = axios.create({
  baseURL: argv["base-url"],
  timeout: 60_000,
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400
});

/* ============================
 * API calls
 * ============================ */
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
  // returns all episodes across seasons for a series (works with episode id or root id in your sample)
  const { data } = await http.get(`/android/videoSeason/id/${id}`);
  return Array.isArray(data) ? data : [];
}

// Optional: direct "episodes by series" endpoint via .env
async function getEpisodesBySeries(seriesId, seasonFilter = null) {
  const tpl = process.env.SERIES_EP_ENDPOINT;        // e.g., /android/seriesEpisodes/id/{seriesId}
  if (!tpl) return null;
  let url = tpl.replace("{seriesId}", encodeURIComponent(seriesId));
  const seasonParam = process.env.SERIES_EP_SEASON_PARAM || null;
  if (seasonParam && seasonFilter) {
    const qs = new URLSearchParams({ [seasonParam]: String(seasonFilter) }).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  const { data } = await http.get(url);
  return data;
}

// Optional: fallback crawl via videoGroups (if your API supports it)
async function getVideoGroups(lang, level) {
  const { data } = await http.get(`/android/videoGroups/lang/${lang}/level/${level}`);
  return data?.groups || [];
}

/* ============================
 * Helpers
 * ============================ */
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

async function streamDownload(url, filePath, skipExisting = false) {
  if (skipExisting && fs.existsSync(filePath)) return;
  const { data, headers } = await http.get(url, { responseType: "stream" });
  const total = Number(headers["content-length"] || 0);

  const bar = new cliProgress.SingleBar(
      { format: `${path.basename(filePath)} | {bar} | {percentage}% | {value}/{total}`, barCompleteChar: "█", barIncompleteChar: "░" },
      cliProgress.Presets.shades_classic
  );
  if (total > 0) bar.start(total, 0, { total: prettyBytes(total) });
  else console.log(`Downloading ${path.basename(filePath)} (size unknown)`);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    let downloaded = 0;
    data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (total > 0) bar.update(downloaded, { value: prettyBytes(downloaded) });
    });
    data.on("error", (err) => { bar.stop(); reject(err); });
    ws.on("error", (err) => { bar.stop(); reject(err); });
    ws.on("finish", () => { bar.stop(); resolve(); });
    data.pipe(ws);
  });
}

async function downloadWithRetry(url, filePath, skipExisting) {
  await pRetry(() => streamDownload(url, filePath, skipExisting), { retries: 4, factor: 2, minTimeout: 800, maxTimeout: 4000 });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: "inherit" });
    proc.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with code ${code}`)); });
  });
}

async function muxSubs(videoPath, subPaths) {
  const out = videoPath.replace(/\.[^.]+$/, "") + ".muxed.mkv";
  const args = ["-y", "-i", videoPath];
  for (const sp of subPaths) args.push("-i", sp);
  // map up to 4 subtitles safely (extend if you want more)
  args.push("-map", "0", "-map", "1?", "-map", "2?", "-map", "3?", "-map", "4?", "-c", "copy", out);
  await runFfmpeg(args);
  return out;
}

async function burnFirstSub(videoPath, subPath) {
  const out = videoPath.replace(/\.[^.]+$/, "") + ".burned.mp4";
  const args = ["-y", "-i", videoPath, "-vf", `subtitles=${subPath}`, "-c:a", "copy", out];
  await runFfmpeg(args);
  return out;
}

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

function buildNameFromTemplate(tpl, vars) {
  return tpl
      .replaceAll("{title}", vars.title)
      .replaceAll("{quality}", vars.quality)
      .replaceAll("{season}", vars.season ?? "")
      .replaceAll("{episode}", vars.episode ?? "");
}

/* ============================
 * SERIES DISCOVERY
 * ============================ */
function normalizeEpisodeIds(list) {
  // Accept items like {id}, {nb}, "123", 123
  return (list || []).map(e => String(e?.id ?? e?.nb ?? e)).filter(Boolean);
}

function wantSeason(seasonFilters, value) {
  if (!seasonFilters || seasonFilters.length === 0) return true;
  const val = String(value ?? "").trim();
  return seasonFilters.some(s => String(s).trim() === val);
}

function normalizeVideoSeasonItems(items, seasonFilters) {
  const want = (season) =>
      !seasonFilters || seasonFilters.length === 0
          ? true
          : seasonFilters.map(String).includes(String(season ?? ""));

  return (items || [])
      .filter(it => String(it?.kind || "") === "2")
      .filter(it => want(it?.season))
      .map(it => ({
        id: String(it?.nb ?? "").trim(),
        season: Number(it?.season ?? 0),
        episode: Number(it?.episodeNummer ?? 0),
        rootSeries: String(it?.rootSeries ?? ""),
      }))
      .filter(it => it.id)
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
      .map(x => x.id);
}

async function discoverEpisodesByEndpoint(seriesId, seasonFilters) {
  const episodes = [];
  if (seasonFilters && seasonFilters.length > 0 && process.env.SERIES_EP_SEASON_PARAM) {
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
  const langs = (process.env.DISCOVER_LANGS || "ar,en").split(",").map(s => s.trim()).filter(Boolean);
  const levels = (process.env.DISCOVER_LEVELS || "0,1,2,3").split(",").map(s => s.trim()).filter(Boolean);

  const found = new Map(); // id -> {id, season, episode}
  for (const lang of langs) {
    for (const level of levels) {
      try {
        const groups = await getVideoGroups(lang, level);
        for (const g of groups) {
          for (const c of (g?.content || [])) {
            if (String(c?.kind || "") !== "2") continue;
            if (String(c?.rootSeries || "") !== String(seriesId)) continue;
            if (!wantSeason(seasonFilters, c?.season)) continue;
            const id = String(c?.nb || "");
            if (!id) continue;
            if (!found.has(id)) {
              found.set(id, { id, season: Number(c?.season ?? 0), episode: Number(c?.episodeNummer ?? 0) });
            }
          }
        }
      } catch {
        // Ignore one group failure and continue
      }
    }
  }
  return [...found.values()]
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
      .map(x => x.id);
}

async function expandSeriesToEpisodeIds(seriesIds, seasonFilters) {
  const out = [];
  for (const sidRaw of seriesIds) {
    const sid = String(sidRaw);
    let eps = [];

    // 0) Preferred: videoSeason
    try {
      const vs = await getVideoSeason(sid);
      const viaVS = normalizeVideoSeasonItems(vs, seasonFilters);
      if (viaVS.length) {
        eps = viaVS;
        console.log(`Discovered ${eps.length} episode(s) for series ${sid} via videoSeason.`);
      }
    } catch (_) {}

    // 1) Configured endpoint (optional)
    if (!eps || eps.length === 0) {
      try {
        const viaCfg = await discoverEpisodesByEndpoint(sid, seasonFilters);
        if (viaCfg.length) {
          eps = viaCfg;
          console.log(`Discovered ${eps.length} episode(s) for series ${sid} via configured endpoint.`);
        }
      } catch (_) {}
    }

    // 2) Fallback crawl (optional)
    if (!eps || eps.length === 0) {
      const crawl = await discoverEpisodesByVideoGroups(sid, seasonFilters);
      eps = crawl;
      if (eps.length) console.log(`Discovered ${eps.length} episode(s) for series ${sid} via videoGroups.`);
    }

    if (eps.length === 0) {
      console.warn(`No episodes discovered for series ${sid}.`);
    }
    out.push(...eps);
  }
  return [...new Set(out)];
}

/* ============================
 * Core pipeline for one ID
 * ============================ */
async function processMovie(id, cfg) {
  console.log(`\n== Movie/Episode ${id} ==`);
  const info = await getAllVideoInfo(id);

  const baseTitle = chooseBaseTitle(info);
  const smartTitle = buildTitle(info);

  const season = pad2(info?.season);
  const episode = pad2(info?.episodeNummer);
  const isSeries = String(info?.kind || "") === "2";

  // quality selection
  const qualities = await getTranscodedFiles(id);
  if (!qualities || qualities.length === 0) {
    console.warn(`No transcoded files for ${id}. Skipping.`);
    return;
  }
  const chosen = pickQuality(qualities, cfg.quality);
  if (!chosen?.videoUrl) {
    console.warn(`No usable quality for ${id}. Skipping.`);
    return;
  }

  const videoUrl = chosen.videoUrl;
  const qname = chosen.name || chosen.resolution || "video";
  const vext  = extFromUrl(videoUrl, ".mp4");

  const expEpoch = parseExpiryEpoch(videoUrl);
  if (isExpiringSoon(expEpoch)) {
    const mins = Math.max(0, Math.round((expEpoch - Math.floor(Date.now()/1000)) / 60));
    console.warn(`⚠️ Video URL for ${id} expires in ~${mins} min; download starting...`);
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
    await downloadWithRetry(videoUrl, vpath, cfg.skipExisting);
  }

  // subtitles
  const subsResp = await getTranslationFiles(id);
  const tracksRaw = Array.isArray(subsResp?.translations) ? subsResp.translations : [];
  const filtered = filterSubtitleTracks(tracksRaw, argv.subs, argv["subs-format"]);
  if (filtered.length === 0) console.log("No matching subtitles.");

  const subPaths = [];
  for (const t of filtered) {
    const sext = "." + t.ext;
    const sname = `${nameCore}.${t.lang}${sext}`;
    const spath = path.join(targetDir, sname);
    const sExp = parseExpiryEpoch(t.url);
    if (isExpiringSoon(sExp)) {
      const mins = Math.max(0, Math.round((sExp - Math.floor(Date.now()/1000)) / 60));
      console.warn(`⚠️ Subtitle (${t.lang}) URL expires in ~${mins} min`);
    }
    if (argv["dry-run"]) {
      console.log(`PLAN: ${sname}`);
    } else {
      await downloadWithRetry(t.url, spath, cfg.skipExisting);
      subPaths.push(spath);
    }
  }

  if (!argv["dry-run"]) {
    if (cfg.burnSubs && subPaths.length > 0) {
      try { const out = await burnFirstSub(vpath, subPaths[0]); console.log(`Burned -> ${out}`); }
      catch (e) { console.error(`Burn failed: ${e.message}`); }
    }
    if (cfg.muxSubs && subPaths.length > 0) {
      try { const out = await muxSubs(vpath, subPaths); console.log(`Muxed -> ${out}`); }
      catch (e) { console.error(`Mux failed: ${e.message}`); }
    }
    console.log(`Done: ${smartTitle}`);
  }
}

/* ============================
 * Main
 * ============================ */
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

  // unique
  ids = [...new Set(ids.map(String))];

  if (ids.length === 0) {
    console.error("Provide --movie <id>, --ids-file <path>, --from-video <episodeId>, or --series <rootSeriesId>.");
    process.exit(1);
  }

  const cfg = {
    output,
    quality: argv.quality,
    skipExisting: argv["skip-existing"],
    muxSubs: argv["mux-subs"],
    burnSubs: argv["burn-subs"]
  };

  const limit = pLimit(Number(argv.concurrency));

  const jobs = ids.map((id) => limit(() =>
      pRetry(() => processMovie(id, cfg), { retries: 2, factor: 2 })
  ));

  try {
    await Promise.all(jobs);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
