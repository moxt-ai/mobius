import { deflateSync } from "node:zlib";

function chunk(kind: string, data: Buffer): Buffer {
    const type = Buffer.from(kind);
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    type.copy(output, 4);
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
        }
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return output;
}

// A real raster with incompressible pixels exercises the Agent's image reader and
// native replay, rather than padding a tiny picture with unrelated bytes.
export function imageFixture(side: number): Buffer {
    const pixels = Buffer.alloc((side * 3 + 1) * side);
    let state = 0x496499;
    for (let y = 0; y < side; y++) {
        for (let x = 1; x <= side * 3; x++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            pixels[y * (side * 3 + 1) + x] = state & 255;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
