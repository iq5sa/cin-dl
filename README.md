# 🎬 cin-dl

`cin-dl` is a command-line downloader for Cinemana’s Android API.

Features:
- Movies, episodes, and full-series downloads
- Subtitles (SRT/VTT)
- Organized folder structure (Show/Sxx/Eyy)
- Quality selection (1080p, 720p…)
- Mux/burn subtitles with ffmpeg
- Retry, auto-filter, concurrency, dry-run

## Install
```bash
git clone https://github.com/iq5sa/cin-dl.git
cd cin-dl
npm install


## Usage
```bash
node cin-dl.js --help
```
Examples:
```bash
# 1) Download a single movie by id
node cin-dl.js --movie 25006

# 2) Download an ENTIRE series from any episode id
node cin-dl.js --from-video 25006 --structure series

# 3) Only Season 3
node cin-dl.js --from-video 25006 --season 3 --structure series

# 4) By root series id (if API supports root in /videoSeason)
node cin-dl.js --series 3293 --structure series

# 5) Multiple explicit ids
node cin-dl.js --movie 25006 --movie 1243796

# 6) With Arabic subtitles only (SRT)
node cin-dl.js --movie 25006 --subs ar --subs-format srt
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