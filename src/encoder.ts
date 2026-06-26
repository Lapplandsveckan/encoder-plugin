import { spawn, type ChildProcess } from 'child_process';
import os from 'os';
import { noTry, noTryAsync } from 'no-try';
import { ffmpegBinary } from './ffmpeg';
import { ENCODER_TAG } from './probe';
import {
    detectVideoEncoder,
    getSpec,
    markEncoderFailed,
    SPECS,
    type VideoEncoderSpec,
} from './hwaccel';

export interface EncodeOptions {
    input: string;
    output: string;
    signal?: AbortSignal;
    onProgress?: (frameTimeMs: number) => void;
}

export interface EncodeImageOptions {
    input: string;
    output: string;
    signal?: AbortSignal;
}

const BASE_VIDEO_FILTERS = [
    'scale=w=1920:h=1080:force_original_aspect_ratio=decrease',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    'format=yuv420p',
    'colorspace=all=bt709:iall=bt2020:fast=1',
];

/**
 * Build ffmpeg args for a video encode using the given encoder spec.
 * The codec/rate-control block comes from the spec; the filter chain,
 * audio, container, and progress args are shared across all encoders.
 */
const ENCODE_ARGS = (
    input: string,
    output: string,
    spec: VideoEncoderSpec,
): string[] => [
    '-hide_banner',
    '-y',
    ...(spec.initArgs ?? []),
    '-i',
    input,
    ...spec.codecArgs,
    '-vf',
    [...BASE_VIDEO_FILTERS, ...(spec.filterSuffix ?? [])].join(','),
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart+use_metadata_tags',
    '-metadata',
    `comment=${ENCODER_TAG}`,
    '-progress',
    'pipe:1',
    '-nostats',
    output,
];

/**
 * Lower the OS scheduling priority of a freshly-spawned ffmpeg so it
 * yields to CasparCG. Linux maps `PRIORITY_LOW` to nice +19; Windows
 * maps it to IDLE_PRIORITY_CLASS. Wrapping in noTry because Node
 * throws when the target PID has already exited (which can happen if
 * ffmpeg crashes on spawn).
 */
function makeLowPriority(proc: ChildProcess) {
    if (proc.pid === undefined) return;
    noTry(() => os.setPriority(proc.pid!, os.constants.priority.PRIORITY_LOW));
}

/** Parse one line of ffmpeg's `-progress pipe:1` output. Lines look like
 *  `out_time_ms=1234567` — we only care about the time-position keys,
 *  which we surface as a "frames so far in ms" hint to callers. */
function parseProgress(line: string): number | null {
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    const key = line.substring(0, eq);
    const value = line.substring(eq + 1).trim();
    if (key === 'out_time_ms') return parseInt(value, 10) / 1000;
    if (key === 'out_time_us') return parseInt(value, 10) / 1000;
    return null;
}

/**
 * Run a single encode. The returned promise resolves when ffmpeg
 * exits 0, rejects on any non-zero exit / spawn error / abort.
 * `signal` lets the caller cancel a job in progress — we send SIGTERM
 * (then SIGKILL after a grace period) and the promise rejects.
 */
/**
 * Image-side encode: normalise a single still image to fit within
 * 1920x1080 (16:9) without upscaling. Letterbox/pillarbox bars are
 * always solid black — we deliberately never use a transparent fill,
 * because the asset typically plays on a channel whose background we
 * don't want to bleed through where the source didn't cover the frame
 * (e.g. a phone-camera video on a programme channel).
 *
 * The scale filter uses `min(iw,1920)` / `min(ih,1080)` so small images
 * pass through at their original dimensions — we only ever shrink.
 */
const IMAGE_ENCODE_ARGS = (input: string, output: string): string[] => [
    '-hide_banner',
    '-y',
    '-i',
    input,
    '-vf',
    [
        "scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease",
        'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
    ].join(','),
    // Output is PNG (driven by the caller's output extension), which is
    // lossless — no quality flag needed.
    output,
];

export function encodeImage(opts: EncodeImageOptions): Promise<void> {
    return runFfmpeg(IMAGE_ENCODE_ARGS(opts.input, opts.output), opts.signal);
}

/** Shared "spawn ffmpeg, watch stderr, resolve/reject" wrapper used by
 *  both the video and image encoders. Pulled out so the SIGTERM-then-
 *  SIGKILL teardown and low-priority handoff aren't duplicated. */
function runFfmpeg(
    args: string[],
    signal?: AbortSignal,
    onProgress?: (frameTimeMs: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegBinary(), args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        makeLowPriority(proc);

        let stderr = '';
        proc.stderr?.on('data', c => {
            stderr += c.toString('utf8');
        });

        if (onProgress) {
            let pending = '';
            proc.stdout?.on('data', (chunk: Buffer) => {
                pending += chunk.toString('utf8');
                let idx: number;
                while ((idx = pending.indexOf('\n')) !== -1) {
                    const line = pending.substring(0, idx);
                    pending = pending.substring(idx + 1);
                    const ms = parseProgress(line);
                    if (ms !== null) onProgress(ms);
                }
            });
        }

        const onAbort = () => {
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL');
            }, 2000).unref();
        };
        signal?.addEventListener('abort', onAbort);

        proc.on('error', err => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
        });

        proc.on('close', (code, sig) => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                reject(new Error('aborted'));
                return;
            }
            if (code === 0) {
                resolve();
                return;
            }
            const tail = stderr.split('\n').slice(-6).join('\n');
            reject(
                new Error(
                    `ffmpeg exited ${code}${sig ? ` (${sig})` : ''}: ${tail}`,
                ),
            );
        });
    });
}

async function runFfmpegWithFallback(
    opts: EncodeOptions,
    spec: VideoEncoderSpec,
): Promise<void> {
    const [err] = await noTryAsync(() =>
        runFfmpeg(
            ENCODE_ARGS(opts.input, opts.output, spec),
            opts.signal,
            opts.onProgress,
        ),
    );
    if (!err) return;
    // Don't retry on abort (user cancelled) or if we're already on software.
    if (opts.signal?.aborted || spec.id === 'libx264') throw err;
    // HW encoder failed at runtime — demote for the rest of the session so
    // subsequent jobs don't pay the failing-GPU penalty.
    markEncoderFailed(spec.id);
    return runFfmpeg(
        ENCODE_ARGS(opts.input, opts.output, SPECS['libx264']),
        opts.signal,
        opts.onProgress,
    );
}

export async function encode(opts: EncodeOptions): Promise<void> {
    const id = await detectVideoEncoder();
    return runFfmpegWithFallback(opts, getSpec(id));
}
