#!/usr/bin/env node
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

// -----------------------------
// CLI
// -----------------------------
const argv = yargs(hideBin(process.argv))
  .option("base-url", {
    type: "string",
    default: (process.env.BASE_URL || "").replace(/\/+$/, ""),
    describe: "e.g., https://cinemana.shabakaty.com",
    demandOption: !process.env.BASE_URL
  })
  .option("output", {
    type: "string",
    default: process.env.OUTPUT_DIR || "downloads",
    describe: "Output folder"
  })
  .option("movie", {
    type: "array",
    describe: "Movie ID(s) to download",
    demandOption: true
  })
  .option("quality", {
    type: "string",
    default: process.env.DEFAULT_QUALITY || "mp4-1080",
    describe: "Preferred quality name from transcoddedFiles (e.g., mp4-1080, mp4-720, m480)"
  })
  .option("concurrency", {
    type: "number",
    default: Number(process.env.CONCURRENCY || 4),
    describe: "Concurrent downloads (items, not chunks)"
  })
  .option("skip-existing", {
    type: "boolean",
    default: false,
    describe: "Skip if target file exists (size not verified)"
  })
  .option("mux-subs", {
    type: "boolean",
    default: false,
    describe: "Attach subtitles into MKV without re-encode (ffmpeg)"
  })
  .option("burn-subs", {
    type: "boolean",
    default: false,
    describe: "Burn first subtitle into video (re-encode, ffmpeg)"
  })
  .option("structure", {
    type: "string",
    default: "flat",
    choices: ["flat", "series"],
    describe: 'Output layout: "flat" (default) or "series" -> Show/S03/…'
  })
  .help()
  .strict()
  .argv;

// -----------------------------
// HTTP client
// -----------------------------
const http = axios.create({
  baseURL: argv["base-url"],
  timeout: 60_000,
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400
});

// -----------------------------
// API calls (your 3 endpoints)
// -----------------------------
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
function pad2(n) {
  const s = String(n ?? "").trim();
  return s ? s.padStart(2, "0") : null;
}

// Build a smarter title:
// - if it's a series (kind==="2") and we have season/episode, append SxxExx
// - choose English title first, fallback to Arabic/other
function buildTitle(info) {
  const base =
    info?.en_title?.trim() ||
    info?.ar_title?.trim() ||
    info?.other_title?.trim() ||
    "untitled";

  const isSeries = String(info?.kind || "") === "2";
  const s = pad2(info?.season);
  const e = pad2(info?.episodeNummer);

  const cleaned = sanitize(base);
  if (isSeries && s && e) return `${cleaned}.S${s}E${e}`;
  return cleaned;
}


// -----------------------------
// Helpers
// -----------------------------
function chooseTitle(info) {
  const title = info?.en_title || info?.ar_title || info?.other_title || "untitled";
  return sanitize(title);
}

function pickQuality(qualities, preferredName) {
  if (!Array.isArray(qualities) || qualities.length === 0) return null;
  const exact = qualities.find(q => q?.name === preferredName);
  if (exact) return exact;

  // fallback to highest numeric resolution
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

async function streamDownload(url, filePath, skipExisting = false) {
  if (skipExisting && fs.existsSync(filePath)) return;

  const { data, headers } = await http.get(url, { responseType: "stream" });
  const total = Number(headers["content-length"] || 0);
  const bar = new cliProgress.SingleBar(
    {
      format: `${path.basename(filePath)} | {bar} | {percentage}% | {value}/{total}`,
      barCompleteChar: "█",
      barIncompleteChar: "░"
    },
    cliProgress.Presets.shades_classic
  );

  if (total > 0) {
    bar.start(total, 0, { total: prettyBytes(total) });
  } else {
    console.log(`Downloading ${path.basename(filePath)} (size unknown)`);
  }

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    let downloaded = 0;

    data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (total > 0) bar.update(downloaded, { value: prettyBytes(downloaded) });
    });

    data.on("error", (err) => {
      bar.stop();
      reject(err);
    });
    ws.on("error", (err) => {
      bar.stop();
      reject(err);
    });
    ws.on("finish", () => {
      bar.stop();
      resolve();
    });

    data.pipe(ws);
  });
}

async function downloadWithRetry(url, filePath, skipExisting) {
  await pRetry(() => streamDownload(url, filePath, skipExisting), {
    retries: 4,
    factor: 2,
    minTimeout: 800,
    maxTimeout: 4000
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function muxSubs(videoPath, subPaths) {
  // mkv output to support multiple subtitle tracks
  const out = videoPath.replace(/\.[^.]+$/, "") + ".muxed.mkv";
  const args = ["-y", "-i", videoPath];

  for (const sp of subPaths) {
    args.push("-i", sp);
  }
  // map video+audio then subs (up to 4)
  args.push(
    "-map", "0",
    "-map", "1?", "-map", "2?", "-map", "3?", "-map", "4?",
    "-c", "copy",
    out
  );
  await runFfmpeg(args);
  return out;
}

async function burnFirstSub(videoPath, subPath) {
  const out = videoPath.replace(/\.[^.]+$/, "") + ".burned.mp4";
  const args = [
    "-y",
    "-i", videoPath,
    "-vf", `subtitles=${subPath}`,
    "-c:a", "copy",
    out
  ];
  await runFfmpeg(args);
  return out;
}

// -----------------------------
// Main
// -----------------------------
async function processMovie(id, cfg) {
  console.log(`\n== Movie ${id} ==`);
  const info = await getAllVideoInfo(id);
  // const title = chooseTitle(info);
  const title = buildTitle(info);

  // video
  const qualities = await getTranscodedFiles(id);
  if (!qualities || qualities.length === 0) {
    console.warn(`No transcoded files for ${id}. Skipping.`);
    return;
  }

  const chosen = pickQuality(qualities, cfg.quality);
  if (!chosen?.videoUrl) {
    console.warn(`Preferred quality not available and no fallback found for ${id}.`);
    return;
  }
  const videoUrl = chosen.videoUrl;
  const qname = chosen.name || chosen.resolution || "video";
  const vext = extFromUrl(videoUrl, ".mp4");
  const vname = `${title}.${qname}${vext}`;

  let targetDir = cfg.output;
  if (argv.structure === "series" && String(info?.kind || "") === "2") {
    const showName = sanitize(info?.en_title || info?.ar_title || info?.other_title || "Series");
    const season = pad2(info?.season) || "00";
    targetDir = path.join(cfg.output, showName, `S${season}`);
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const vpath = path.join(targetDir, vname);

  await downloadWithRetry(videoUrl, vpath, cfg.skipExisting);

  // subtitles
  const subsResp = await getTranslationFiles(id);
  const subsArr = Array.isArray(subsResp?.translations) ? subsResp.translations : [];
  const subPaths = [];

  for (const t of subsArr) {
    const surl = t?.file;
    const lang = t?.type || t?.name || "sub";
    if (!surl || /defaultImages\/loading\.gif/i.test(surl)) continue;

    const sext = subExt(surl);
    const sname = `${title}.${lang}${sext}`;
    const spath = path.join(targetDir, sname);
    await downloadWithRetry(surl, spath, cfg.skipExisting);
    subPaths.push(spath);
  }

  // post-processing
  if (cfg.burnSubs && subPaths.length > 0) {
    try {
      const out = await burnFirstSub(vpath, subPaths[0]);
      console.log(`Burned -> ${out}`);
    } catch (e) {
      console.error(`Burn failed: ${e.message}`);
    }
  }

  if (cfg.muxSubs && subPaths.length > 0) {
    try {
      const out = await muxSubs(vpath, subPaths);
      console.log(`Muxed -> ${out}`);
    } catch (e) {
      console.error(`Mux failed: ${e.message}`);
    }
  }

  console.log(`Done: ${title}`);
}

async function main() {
  const output = path.resolve(argv.output);
  fs.mkdirSync(output, { recursive: true });

  const cfg = {
    baseUrl: argv["base-url"],
    output,
    quality: argv.quality,
    skipExisting: argv["skip-existing"],
    muxSubs: argv["mux-subs"],
    burnSubs: argv["burn-subs"]
  };


  const limit = pLimit(Number(argv.concurrency));
  const jobs = argv.movie.map((id) => limit(() => pRetry(() => processMovie(String(id), cfg), {
    retries: 2,
    factor: 2
  })));

  try {
    await Promise.all(jobs);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();