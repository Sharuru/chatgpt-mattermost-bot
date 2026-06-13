import sharp from "sharp";
import {ModelAttachment} from "./attachment-utils";
import {botLog} from "./logging";

export type ImageOutputSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';
export type ImageSizeMode = ImageOutputSize | 'match-reference';

export type PreparedReferenceImage = {
    name: string,
    mimeType: 'image/jpeg' | 'image/png',
    buffer: Buffer,
    width?: number,
    height?: number
}

const maxInputEdge = Number(process.env['OPENAI_IMAGE_MAX_INPUT_EDGE'] ?? 2048);
const maxInputPixels = Number(process.env['OPENAI_IMAGE_MAX_INPUT_PIXELS'] ?? 4_000_000);
const maxInputBytes = Number(process.env['OPENAI_IMAGE_MAX_INPUT_BYTES'] ?? 8 * 1024 * 1024);
const jpegQuality = Number(process.env['OPENAI_IMAGE_JPEG_QUALITY'] ?? 90);

export async function prepareReferenceImages(
    attachments: Array<ModelAttachment & {base64Data: string}>
): Promise<PreparedReferenceImage[]> {
    const result: PreparedReferenceImage[] = [];

    for (const attachment of attachments) {
        try {
            result.push(await prepareReferenceImage(attachment));
        } catch (error) {
            botLog.error({message: 'Failed to normalize reference image', filename: attachment.name, error});
        }
    }

    return result;
}

export function normalizeImageOutputSize(value: string | undefined): ImageSizeMode {
    switch ((value ?? 'auto').toLowerCase()) {
        case '1024x1024':
        case '1536x1024':
        case '1024x1536':
        case 'auto':
            return value!.toLowerCase() as ImageSizeMode;
        case 'match-reference':
            return 'match-reference';
        default:
            return 'auto';
    }
}

async function prepareReferenceImage(attachment: ModelAttachment & {base64Data: string}): Promise<PreparedReferenceImage> {
    const input = Buffer.from(attachment.base64Data, 'base64');
    const source = sharp(input, {failOn: 'none'}).rotate();
    const metadata = await source.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const resize = getResizeOptions(width, height);
    const hasAlpha = !!metadata.hasAlpha;
    let outputFormat: 'png' | 'jpeg' = hasAlpha ? 'png' : 'jpeg';
    let buffer = await encodeImage(source, resize, outputFormat, jpegQuality);

    if (buffer.length > maxInputBytes) {
        outputFormat = 'jpeg';
        buffer = await shrinkToByteLimit(source, resize, width, height);
    }

    const normalizedMetadata = await sharp(buffer).metadata();
    return {
        name: replaceExtension(attachment.name, outputFormat === 'png' ? 'png' : 'jpg'),
        mimeType: outputFormat === 'png' ? 'image/png' : 'image/jpeg',
        buffer,
        width: normalizedMetadata.width,
        height: normalizedMetadata.height
    };
}

function getResizeOptions(width: number, height: number): sharp.ResizeOptions | undefined {
    if (!width || !height) {
        return {
            width: maxInputEdge,
            height: maxInputEdge,
            fit: 'inside',
            withoutEnlargement: true
        };
    }

    const edgeScale = Math.min(1, maxInputEdge / Math.max(width, height));
    const pixelScale = Math.min(1, Math.sqrt(maxInputPixels / (width * height)));
    const scale = Math.min(edgeScale, pixelScale);

    if (scale >= 1) {
        return undefined;
    }

    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: 'inside',
        withoutEnlargement: true
    };
}

function replaceExtension(filename: string, extension: string): string {
    return filename.includes('.')
        ? filename.replace(/\.[^.]+$/, `.${extension}`)
        : `${filename}.${extension}`;
}

async function shrinkToByteLimit(
    source: sharp.Sharp,
    initialResize: sharp.ResizeOptions | undefined,
    sourceWidth: number,
    sourceHeight: number
): Promise<Buffer> {
    let resize = initialResize;
    let quality = 82;
    let buffer = await encodeImage(source, resize, 'jpeg', quality);

    for (let attempt = 0; attempt < 4 && buffer.length > maxInputBytes; attempt++) {
        const currentWidth = resize?.width ?? sourceWidth;
        const currentHeight = resize?.height ?? sourceHeight;
        const scale = Math.min(0.85, Math.sqrt(maxInputBytes / buffer.length) * 0.95);
        resize = {
            width: Math.max(1, Math.round((currentWidth || maxInputEdge) * scale)),
            height: Math.max(1, Math.round((currentHeight || maxInputEdge) * scale)),
            fit: 'inside',
            withoutEnlargement: true
        };
        quality = Math.max(70, quality - 4);
        buffer = await encodeImage(source, resize, 'jpeg', quality);
    }

    return buffer;
}

async function encodeImage(
    source: sharp.Sharp,
    resize: sharp.ResizeOptions | undefined,
    format: 'png' | 'jpeg',
    quality: number
): Promise<Buffer> {
    const pipeline = source.clone().resize(resize);
    if (format === 'png') {
        return pipeline.png({compressionLevel: 9}).toBuffer();
    }

    return pipeline
        .flatten({background: '#ffffff'})
        .jpeg({quality, mozjpeg: true})
        .toBuffer();
}
