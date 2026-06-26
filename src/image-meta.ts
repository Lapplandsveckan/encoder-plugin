import path from 'path';
import { promises as fs } from 'fs';
import { noTryAsync } from 'no-try';
import extract from 'png-chunks-extract';
import encode from 'png-chunks-encode';
import text from 'png-chunk-text';
import { ENCODER_TAG_NAME, ENCODER_VERSION } from './probe';

// 8-byte PNG signature precedes the first chunk.
const PNG_SIG_LEN = 8;
// Our marker is inserted right after IHDR, so the first chunk of the file is
// always enough to find it — no need to read a multi-MB image in full.
const MARKER_PREFIX_BYTES = 64 * 1024;

/**
 * Inject a tEXt marker chunk into a freshly-encoded PNG (modifies the file
 * in place). Call on the temp file before it's moved into place, so an
 * unstamped output never reaches the media root.
 *
 * The chunk is inserted right after IHDR (index 1) so it appears near the
 * top of the stream and is easy to find on read.
 */
export async function stampImage(filePath: string): Promise<void> {
    const buf = await fs.readFile(filePath);
    const chunks = extract(buf);
    chunks.splice(1, 0, text.encode(ENCODER_TAG_NAME, String(ENCODER_VERSION)));
    await fs.writeFile(filePath, Buffer.from(encode(chunks)));
}

/** Read up to `max` bytes from the start of a file. Returns an empty buffer
 *  on any error so callers can treat "couldn't read" as "not encoded". */
async function readPrefix(filePath: string, max: number): Promise<Buffer> {
    const [openErr, fh] = await noTryAsync(() => fs.open(filePath, 'r'));
    if (openErr || !fh) return Buffer.alloc(0);
    const buf = Buffer.alloc(max);
    const [readErr, res] = await noTryAsync(() => fh.read(buf, 0, max, 0));
    await noTryAsync(() => fh.close());
    if (readErr || !res) return Buffer.alloc(0);
    return buf.subarray(0, res.bytesRead);
}

/**
 * Read the encoder version from a PNG's tEXt marker, or null if absent.
 * A non-PNG file is by definition not yet encoded (encoded images are
 * always PNG), so non-PNG extensions return null without reading the file.
 *
 * Walks chunks manually over a bounded prefix rather than reading + parsing
 * the whole file: our marker always sits right after IHDR, so if it isn't in
 * the first chunk it isn't there. Stopping at the first chunk that runs past
 * the prefix (typically the big IDAT) keeps this header-bounded.
 */
export async function readImageMarker(
    filePath: string,
): Promise<number | null> {
    if (path.extname(filePath).toLowerCase() !== '.png') return null;

    const buf = await readPrefix(filePath, MARKER_PREFIX_BYTES);

    let off = PNG_SIG_LEN;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const dataStart = off + 8;
        if (type === 'IEND') break;
        // Chunk (data + 4-byte CRC) runs past what we read — and our marker
        // would have appeared before it — so we're done.
        if (dataStart + len + 4 > buf.length) break;
        if (type === 'tEXt') {
            const { keyword, text: value } = text.decode(
                buf.subarray(dataStart, dataStart + len),
            );
            if (keyword === ENCODER_TAG_NAME) {
                const n = parseInt(value, 10);
                return Number.isFinite(n) ? n : null;
            }
        }
        off = dataStart + len + 4;
    }
    return null;
}
