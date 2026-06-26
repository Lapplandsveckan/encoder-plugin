import path from 'path';
import { promises as fs } from 'fs';
import { noTryAsync } from 'no-try';

/**
 * Resolve where an encoded file should land given its source path and the
 * pipeline's fixed output extension (image→.png, video→.mp4).
 *
 * If the source already has that extension we replace it in place (same
 * name). Otherwise (jpg→png, mov→mp4) the output gets a new name; if a
 * differently-sourced file already owns it we disambiguate with ` (1)`,
 * ` (2)`, … so we never clobber an unrelated asset. `renamed` tells the
 * caller whether the original source should be removed afterwards.
 */
export async function resolveDest(
    src: string,
    targetExt: string,
): Promise<{ dest: string; renamed: boolean }> {
    if (path.extname(src).toLowerCase() === targetExt)
        return { dest: src, renamed: false };

    const dir = path.dirname(src);
    const base = path.basename(src, path.extname(src));
    let candidate = path.join(dir, base + targetExt);
    for (let n = 1; ; n++) {
        const [err] = await noTryAsync(() => fs.access(candidate));
        if (err) break; // access failed → doesn't exist → free
        candidate = path.join(dir, `${base} (${n})${targetExt}`);
    }
    return { dest: candidate, renamed: true };
}

/**
 * Move `src` onto `dest`, falling back to copy+unlink when they live on
 * different volumes (EXDEV) — which is the norm here, since `src` is in
 * `os.tmpdir()` and `dest` is under the media root.
 */
async function moveInto(src: string, dest: string): Promise<Error | null> {
    const [err] = await noTryAsync(() => fs.rename(src, dest));
    if (err && (err as NodeJS.ErrnoException).code === 'EXDEV') {
        const [copyErr] = await noTryAsync(() => fs.copyFile(src, dest));
        if (copyErr) return copyErr;
        await noTryAsync(() => fs.unlink(src)); // best-effort
        return null;
    }
    return err ?? null;
}

/**
 * Replace `dest` with `src` as reliably as possible across platforms.
 *
 * On POSIX this is a single `rename` (atomic even over an existing file),
 * with a cross-device copy fallback. On Windows, renaming directly onto an
 * open file (e.g. a video that's currently playing) fails with EPERM, so we
 * first move the existing file aside — Windows allows this for files opened
 * with FILE_SHARE_DELETE, which most media players use — then move `src`
 * into place, and only unlink the aside copy once that succeeds. If anything
 * fails, the aside copy is restored so `dest` is never left missing.
 *
 * Not atomic on Windows, but failure-safe. Returns the first unrecoverable
 * error, or null on success.
 */
export async function safeReplace(
    src: string,
    dest: string,
): Promise<Error | null> {
    if (process.platform !== 'win32') return moveInto(src, dest);

    const stale = `${dest}.deleting-${process.pid}`;
    const [asideErr] = await noTryAsync(() => fs.rename(dest, stale));
    if (asideErr) {
        const code = (asideErr as NodeJS.ErrnoException).code;
        // ENOENT: nothing to move aside, proceed normally.
        if (code === 'ENOENT') return moveInto(src, dest);
        return asideErr;
    }

    const err = await moveInto(src, dest);
    if (err) {
        await noTryAsync(() => fs.rename(stale, dest)); // restore
        return err;
    }
    await noTryAsync(() => fs.unlink(stale)); // best-effort; OS removes when handles close
    return null;
}
