#!/usr/bin/env node
/**
 * Sync a freshly downloaded subtitle against the subtitle track that is EMBEDDED in the video.
 *
 * Bazarr's own automatic sync only ever uses the audio (voice detection), which is often poor. Bazarr can run a command
 * after every download, so the Hub points that hook at this script:
 *
 *   node embedded-sync.js <video> <subtitle file> <language code, e.g. eng or eng:hi>
 *
 * It picks the best text subtitle track inside the video (same language first, never forced/signs-only tracks), then lets
 * Bazarr's own copy of ffsubsync align the downloaded file to it (`--reference-stream s:N`). If the video has no usable
 * embedded subtitles, or anything goes wrong, the downloaded file is left exactly as it was.
 * Messages go to stdout (Bazarr logs them as info); stderr is only used for real failures.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Text-based subtitle formats ffmpeg can turn into SRT. Picture formats (PGS, VobSub) can't be a timing reference. */
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

/** ISO 639-2/B codes (what MKV/MP4 tags use) -> the /T codes Bazarr uses, for the languages where they differ. */
const B_TO_T = {
  fre: 'fra', ger: 'deu', chi: 'zho', dut: 'nld', cze: 'ces', gre: 'ell', ice: 'isl', rum: 'ron', slo: 'slk',
  per: 'fas', may: 'msa', mac: 'mkd', mao: 'mri', tib: 'bod', wel: 'cym', baq: 'eus', arm: 'hye', geo: 'kat',
  bur: 'mya', alb: 'sqi',
};
const norm = (code) => {
  const c = String(code ?? '').toLowerCase().split(':')[0].trim();
  return B_TO_T[c] ?? c;
};

/**
 * Choose which embedded subtitle track to sync against. `streams` is ffprobe's list of subtitle streams in file
 * order (the position in that list is what ffmpeg calls s:N). Returns { n, stream } or null.
 */
export function pickReference(streams, language, { hearingImpaired = false } = {}) {
  const want = norm(language);
  let best = null;
  streams.forEach((stream, n) => {
    if (!TEXT_CODECS.has(String(stream.codec_name).toLowerCase())) return;
    const tags = stream.tags ?? {};
    const title = String(tags.title ?? tags.TITLE ?? '');
    if (stream.disposition?.forced || /forced|signs|songs|commentary/i.test(title)) return; // partial or non-dialogue tracks
    const lang = norm(tags.language ?? tags.LANGUAGE);
    const bytes = Number(tags['NUMBER_OF_BYTES'] ?? tags['NUMBER_OF_BYTES-eng'] ?? 0);
    const isHi = !!stream.disposition?.hearing_impaired || /\b(sdh|hi|cc)\b|hearing/i.test(title);
    const score =
      (lang && lang === want ? 100 : 0) + // same language: best reference
      (isHi === hearingImpaired ? 10 : 0) + // matching style (SDH text vs plain dialogue)
      (stream.disposition?.default ? 1 : 0) +
      Math.min(5, Math.log10(bytes + 1)); // a bigger track is a fuller one when nothing else decides
    if (!best || score > best.score) best = { n, stream, score };
  });
  return best;
}

function paths() {
  const apps = process.env.ALLARR_APPS_DIR || '/opt';
  return {
    python: process.env.ALLARR_FFSUBSYNC_PYTHON || path.join(apps, 'venv-bazarr', 'bin', 'python'),
    libs: process.env.ALLARR_FFSUBSYNC_LIBS || path.join(apps, 'bazarr', 'libs'), // Bazarr ships ffsubsync in here
  };
}

async function ffmpegDir() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))) return dir;
  }
  return '/usr/bin';
}

async function subtitleStreams(video) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 's',
    '-show_entries', 'stream=index,codec_name:stream_tags:stream_disposition',
    '-of', 'json', video,
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return JSON.parse(stdout).streams ?? [];
}

const SYNC_LIMIT_MS = 30 * 60_000;

async function ffsubsync(video, input, output, n) {
  const { python, libs } = paths();
  const base = [
    video, '-i', input, '-o', output, '--reference-stream', `s:${n}`,
    '--ffmpegpath', await ffmpegDir(), '--output-encoding', 'same',
    '--max-offset-seconds', '60', '--gss', '--no-fix-framerate',
  ];
  // Reject implausible alignments (Bazarr's own defaults) instead of writing a worse file.
  const quality = ['--skip-sync-on-low-quality', '--min-score', '0', '--quality-max-offset-seconds', '30'];
  const go = (extra) => run(python, ['-c', 'import sys; from ffsubsync.ffsubsync import main; sys.exit(main())', ...base, ...extra], {
    env: { ...process.env, PYTHONPATH: libs }, timeout: SYNC_LIMIT_MS, maxBuffer: 32 * 1024 * 1024,
  });
  try {
    return await go(quality);
  } catch (e) {
    if (!/unrecognized arguments/i.test(String(e.stderr ?? ''))) throw e;
    return go([]); // an older ffsubsync without the quality flags
  }
}

/** Returns a one-line result for the log. Never throws for "nothing to do". */
export async function syncWithEmbedded(video, subtitle, language) {
  if (!video || !subtitle) throw new Error('usage: embedded-sync.js <video> <subtitle> <language>');
  if (/:forced$/i.test(language ?? '')) return 'Embedded sync skipped: forced subtitles are not synced';
  if (!fs.existsSync(video) || !fs.existsSync(subtitle)) return 'Embedded sync skipped: file not found';

  const hearingImpaired = /:hi$/i.test(language ?? '');
  const ref = pickReference(await subtitleStreams(video), language, { hearingImpaired });
  if (!ref) return 'Embedded sync skipped: the video has no usable embedded text subtitles';

  const ext = path.extname(subtitle);
  const tmp = `${subtitle.slice(0, subtitle.length - ext.length)}.embsync${ext}`;
  try {
    const { stderr } = await ffsubsync(video, subtitle, tmp, ref.n);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return 'Embedded sync skipped: ffsubsync judged the match unreliable, subtitle left as downloaded';
    if (fs.readFileSync(tmp).equals(fs.readFileSync(subtitle))) return `Embedded sync: already in step with embedded track s:${ref.n}`;
    fs.renameSync(tmp, subtitle); // same folder, so this replaces the file in one step
    const offset = /offset seconds:\s*(-?[\d.]+)/i.exec(stderr ?? '')?.[1];
    const lang = ref.stream.tags?.language ?? 'unknown language';
    return `Embedded sync: aligned ${path.basename(subtitle)} to the embedded ${lang} track s:${ref.n}${offset ? ` (shifted ${offset}s)` : ''}`;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [video, subtitle, language] = process.argv.slice(2);
  syncWithEmbedded(video, subtitle, language).then(
    (msg) => console.log(msg),
    (err) => {
      // Leave the downloaded subtitle alone; Bazarr logs stderr as an error so the reason is visible.
      console.error(`Embedded sync failed, subtitle left as downloaded: ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' | ')}`);
    },
  );
}
