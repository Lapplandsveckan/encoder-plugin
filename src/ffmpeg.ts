import path from 'path';
import { existsSync } from 'fs';

let casparPath: string | null = null;
const pathChangeListeners: Array<() => void> = [];

export function setCasparPath(p: string | null | undefined) {
    casparPath = p || null;
    pathChangeListeners.forEach(cb => cb());
}

/** Register a callback invoked whenever the caspar path changes. Used by
 *  hwaccel.ts to clear the encoder-detection cache without a circular import. */
export function onCasparPathChange(cb: () => void) {
    pathChangeListeners.push(cb);
}

/**
 * Locate the ffmpeg binary CasparCG ships with. Falls back to a PATH
 * lookup ("ffmpeg") when caspar-path isn't set or the bundled binary
 * isn't where we expect — useful in dev where the manager runs without
 * caspar installed alongside.
 */
export function ffmpegBinary(): string {
    if (!casparPath) return 'ffmpeg';

    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundled = path.join(casparPath, `ffmpeg${ext}`);

    return existsSync(bundled) ? bundled : 'ffmpeg';
}
