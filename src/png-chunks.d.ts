interface PngChunk {
    name: string;
    data: Uint8Array;
}

declare module 'png-chunks-extract' {
    function extractChunks(data: Uint8Array | Buffer): PngChunk[];
    export = extractChunks;
}

declare module 'png-chunks-encode' {
    function encodeChunks(chunks: PngChunk[]): Uint8Array;
    export = encodeChunks;
}

declare module 'png-chunk-text' {
    function encode(keyword: string, content: string): PngChunk;
    function decode(data: PngChunk | Uint8Array): {
        keyword: string;
        text: string;
    };
    export { encode, decode };
}
