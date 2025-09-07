# 🎬 Cinemana Downloader (Node.js CLI)

A command-line tool to download videos and subtitles from Cinemana’s Android API.

Supports:
- 🎥 Single movies or episodes (`--movie`)
- 📺 Full series discovery by **episode id** (`--from-video`) or **root series id** (`--series`)
- 📂 Organized folders `Show/Sxx/Show.SxxEyy.mp4`
- 🌐 Multiple qualities (`mp4-1080`, `mp4-720`, etc.)
- 📝 Subtitles (SRT / VTT), filter by language/format
- 🔧 Extras:
    - `--mux-subs` → attach subs (MKV, no re-encode)
    - `--burn-subs` → burn first sub (re-encode)
    - `--dry-run` → preview plan without downloading
    - Retry, progress bars, concurrency

---

## 🚀 Quick Start

```bash
git clone https://github.com/iq5sa/cinemana-downloader.git
cd cinemana-downloader
cp .env.example .env
npm install
```

## Usage
```bash
node cinemana-dl.js --help
```
Examples:
```bash
# 1) Download a single movie by id
node cinemana-dl.js --movie 25006

# 2) Download an ENTIRE series from any episode id
node cinemana-dl.js --from-video 25006 --structure series

# 3) Only Season 3
node cinemana-dl.js --from-video 25006 --season 3 --structure series

# 4) By root series id (if API supports root in /videoSeason)
node cinemana-dl.js --series 3293 --structure series

# 5) Multiple explicit ids
node cinemana-dl.js --movie 25006 --movie 1243796

# 6) With Arabic subtitles only (SRT)
node cinemana-dl.js --movie 25006 --subs ar --subs-format srt
```

## Cli Options
```
  --base-url       API base URL (default from .env)
  --output         Output folder (default from .env)
  --movie          Movie/Episode id(s)
  --from-video     Episode id(s) → expand to full series
  --series         Root series id(s)
  --season         Season filter(s) when using --from-video / --series
  --ids-file       File with ids (one per line)
  --quality        Preferred quality (default: mp4-1080)
  --concurrency    Concurrent downloads (default: 4)
  --skip-existing  Skip already existing files
  --subs           Comma-separated subtitle languages (e.g. ar,en)
  --subs-format    Subtitle format: srt | vtt | both
  --mux-subs       Attach subs into MKV (ffmpeg, no re-encode)
  --burn-subs      Burn first subtitle (ffmpeg re-encode)
  --structure      flat | series (default: flat)
  --dry-run        Plan only (no downloads)
  --name-template  Filename template, e.g. "{title}.S{season}E{episode}.{quality}"

```

## Configuration
.env keys:
```env
BASE_URL=https://cinemana.shabakaty.com
OUTPUT_DIR=downloads
DEFAULT_QUALITY=mp4-1080
CONCURRENCY=4

# Optional advanced discovery
# SERIES_EP_ENDPOINT=/android/seriesEpisodes/id/{seriesId}
# SERIES_EP_SEASON_PARAM=season
# DISCOVER_LANGS=ar,en
# DISCOVER_LEVELS=0,1,2,3

```