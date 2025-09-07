# Cinemana Downloader (Node.js CLI)

Download Cinemana videos (by **movie/episode ID**) and all available subtitles using the official Android API endpoints you already shared.

- Uses exactly these three endpoints:
    - `GET /android/allVideoInfo/id/{movieId}`
    - `GET /android/transcoddedFiles/id/{movieId}`
    - `GET /android/translationFiles/id/{movieId}`
- Picks a target **quality** (`mp4-1080`, `mp4-720`, etc.) or falls back to highest
- Downloads all subtitle tracks (SRT/VTT)
- Episode-aware filenames: `Show.S03E01.mp4-1080.mp4`
- Optional series folders: `Show/S03/<files>`
- Retries + progress bars
- Optional `ffmpeg` steps: `--mux-subs` or `--burn-subs`

> **Note**  
> This tool assumes your endpoints are accessible without authentication (as demonstrated). If your deployment needs headers/cookies, you can add them in one place (the Axios client).

---

## Requirements

- Node.js 18+
- `ffmpeg` in PATH **only** if you want `--mux-subs` or `--burn-subs`

---

## Quick Start

```bash
git clone https://github.com/iq5sa/cinemana-downloader.git
cd cinemana-downloader
cp .env.example .env
npm i
```

## Usage

```bash
# one episode/movie by ID, auto-pick 1080p (or highest)
node cinemana-dl.js --movie 25006

# pick a specific quality (uses "name" from transcoddedFiles)
node cinemana-dl.js --movie 25006 --quality mp4-720

# multiple IDs
node cinemana-dl.js --movie 25006 --movie 1243796

# choose output folder
node cinemana-dl.js --movie 25006 --output ./videos

# keep a tidy series layout: Show/S03/...
node cinemana-dl.js --movie 25006 --structure series

# attach subs (MKV, no re-encode) or burn first sub (re-encode)
node cinemana-dl.js --movie 25006 --mux-subs
node cinemana-dl.js --movie 25006 --burn-subs
```

## Cli Options
```
--base-url       API base URL (default from .env)
--output         Output folder (default from .env)
--movie          Movie/Episode ID (repeatable)
--quality        Preferred quality name (e.g., mp4-1080)
--concurrency    Parallelism across IDs (default 4)
--skip-existing  Skip files that already exist
--mux-subs       Mux all subtitles into MKV (needs ffmpeg)
--burn-subs      Burn first subtitle into video (needs ffmpeg)
--structure      Output layout: flat | series (default: flat)
--help           Show help
```

## Configuration
.env keys:
```
BASE_URL=https://cinemana.shabakaty.com
OUTPUT_DIR=downloads
DEFAULT_QUALITY=mp4-1080
CONCURRENCY=4
```