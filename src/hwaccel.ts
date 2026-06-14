import {spawn} from 'child_process';
import {ffmpegBinary, onCasparPathChange} from './ffmpeg';

// Clear the encoder-detection memo whenever the caspar path changes so the
// next job re-probes against the (potentially different) bundled binary.
onCasparPathChange(() => resetVideoEncoderCache());

export interface VideoEncoderSpec {
    id: string;
    codecArgs: string[];
    filterSuffix?: string[];
    initArgs?: string[];
}

export const SPECS: Record<string, VideoEncoderSpec> = {
    'libx264': {
        id: 'libx264',
        codecArgs: ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'film', '-crf', '18'],
    },
    'h264_nvenc': {
        id: 'h264_nvenc',
        // VBR + -cq (constant-quality) mode. -b:v 0 is required so nvenc
        // doesn't treat -cq as a bitrate cap — without it cq is ignored.
        codecArgs: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-profile:v', 'high'],
    },
    'h264_qsv': {
        id: 'h264_qsv',
        // ICQ mode (-global_quality) is QSV's constant-quality equivalent.
        // QSV prefers hardware surfaces, so we upload CPU frames produced
        // by the software filter chain before the encoder sees them.
        codecArgs: ['-c:v', 'h264_qsv', '-global_quality', '20', '-preset', 'veryslow', '-profile:v', 'high'],
        filterSuffix: ['hwupload=extra_hw_frames=64'],
    },
    'h264_videotoolbox': {
        id: 'h264_videotoolbox',
        // VideoToolbox has no CRF — -q:v is a 1-100 quality scale.
        // ~55 is empirically close to libx264 CRF 18 on Apple Silicon.
        codecArgs: ['-c:v', 'h264_videotoolbox', '-q:v', '55', '-profile:v', 'high'],
    },
};

/** Platform-gated candidates in priority order. */
function candidates(): string[] {
    if (process.platform === 'darwin') {
        return ['h264_videotoolbox', 'libx264'];
    }
    return ['h264_nvenc', 'h264_qsv', 'libx264'];
}

function probeEncoder(encoderId: string): Promise<boolean> {
    return new Promise((resolve) => {
        // Use testsrc (not nullsrc) so the encoder fully initializes its
        // session — some HW encoders skip init with no real pixels and
        // appear to succeed without touching the GPU/driver.
        const proc = spawn(ffmpegBinary(), [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'testsrc=size=320x240:rate=30',
            '-t', '0.2',
            '-c:v', encoderId,
            '-profile:v', 'high',
            '-f', 'null', '-',
        ], {stdio: 'ignore'});

        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
    });
}

let detected: Promise<string> | null = null;

/** Reset the memo so the next job re-probes (called when the ffmpeg binary changes). */
export function resetVideoEncoderCache() {
    detected = null;
}

/** Pin the cache to libx264 for the rest of the session after a runtime HW failure. */
export function markEncoderFailed(id: string) {
    if (id !== 'libx264') detected = Promise.resolve('libx264');
}

/**
 * Probe the actual bundled ffmpeg for a working HW encoder and memoize the
 * result. Candidates are platform-gated and tried in priority order; the
 * first exit-0 probe wins. Always resolves — libx264 is the terminal fallback.
 */
export function detectVideoEncoder(): Promise<string> {
    if (!detected) {
        detected = (async () => {
            for (const id of candidates()) {
                if (id === 'libx264') return 'libx264';
                if (await probeEncoder(id)) return id;
            }
            return 'libx264';
        })();
    }
    return detected;
}

export function getSpec(id: string): VideoEncoderSpec {
    return SPECS[id] ?? SPECS['libx264'];
}
