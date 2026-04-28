import 'isomorphic-fetch';
import OpenAI from 'openai';
import {inflateRawSync} from "zlib";
import {FileInfo} from "@mattermost/types/lib/files";
import {Post} from "@mattermost/types/lib/posts";
import {mmClient} from "./mm-client";
import {matterMostLog} from "./logging";

const mattermostToken = process.env['MATTERMOST_TOKEN']!;
const maxAttachmentBytes = Number(process.env['OPENAI_MAX_ATTACHMENT_BYTES'] ?? 10 * 1024 * 1024);
const maxAttachmentCount = Number(process.env['OPENAI_MAX_ATTACHMENT_COUNT'] ?? 4);
const maxAttachmentTextChars = Number(process.env['OPENAI_MAX_ATTACHMENT_TEXT_CHARS'] ?? 20000);
const maxAttachmentTextBudget = Number(process.env['OPENAI_MAX_ATTACHMENT_TEXT_BUDGET'] ?? 30000);
const maxSpreadsheetSheets = Number(process.env['OPENAI_MAX_SPREADSHEET_SHEETS'] ?? 5);
const maxSpreadsheetRows = Number(process.env['OPENAI_MAX_SPREADSHEET_ROWS'] ?? 50);
const maxSpreadsheetCols = Number(process.env['OPENAI_MAX_SPREADSHEET_COLS'] ?? 20);
const attachmentCacheTtlMs = Number(process.env['OPENAI_ATTACHMENT_CACHE_TTL_MS'] ?? 5 * 60 * 1000);

const textLikeDocumentMimeTypes = new Set([
    'application/json',
    'application/xml',
    'text/csv',
]);

const textLikeDocumentExtensions = new Set([
    'c',
    'cpp',
    'cs',
    'css',
    'csv',
    'go',
    'htm',
    'html',
    'java',
    'js',
    'json',
    'log',
    'markdown',
    'md',
    'php',
    'py',
    'rb',
    'sh',
    'sql',
    'tex',
    'ts',
    'txt',
    'xml',
    'yaml',
    'yml',
]);

const officeDocumentExtensions = new Set([
    'docx',
    'xlsx',
]);

export type ModelAttachment = {
    id: string,
    name: string,
    mimeType: string,
    size: number,
    kind: 'image' | 'document',
    base64Data?: string,
    dataUrl?: string,
    extractedText?: string
}

export type ResolvedAttachments = {
    supported: ModelAttachment[],
    omitted: string[]
}

const attachmentCache: Map<string, {expireTime: number, result: Promise<ResolvedAttachments>}> = new Map();

export async function resolvePostAttachments(post: Post): Promise<ResolvedAttachments> {
    const cacheKey = `${post.id}:${(post.file_ids ?? []).join(',')}`;
    const cached = attachmentCache.get(cacheKey);
    if (cached && Date.now() < cached.expireTime) {
        return cached.result;
    }

    const pending = resolvePostAttachmentsUncached(post);
    attachmentCache.set(cacheKey, {
        expireTime: Date.now() + attachmentCacheTtlMs,
        result: pending
    });

    try {
        return await pending;
    } catch (error) {
        attachmentCache.delete(cacheKey);
        throw error;
    }
}

async function resolvePostAttachmentsUncached(post: Post): Promise<ResolvedAttachments> {
    if (!post.file_ids?.length) {
        return {supported: [], omitted: []};
    }

    const fileInfos = await mmClient.getFileInfosForPost(post.id);
    const supported: ModelAttachment[] = [];
    const omitted: string[] = [];

    for (const fileInfo of fileInfos.slice(0, maxAttachmentCount)) {
        if (fileInfo.size > maxAttachmentBytes) {
            omitted.push(`${fileInfo.name}（超过 ${(maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB 限制）`);
            continue;
        }

        const kind = getAttachmentKind(fileInfo);
        if (!kind) {
            omitted.push(`${fileInfo.name}（暂不支持的文件类型 ${fileInfo.mime_type || fileInfo.extension || 'unknown'}）`);
            continue;
        }

        try {
            const buffer = await downloadMattermostFile(fileInfo);
            const mimeType = fileInfo.mime_type || inferMimeType(fileInfo);
            const base64Data = buffer.toString('base64');

            if (kind === 'document') {
                const extractedText = extractDocumentText(buffer, fileInfo);
                if (!extractedText) {
                    omitted.push(`${fileInfo.name}（当前无法解析该文档内容）`);
                    continue;
                }

                supported.push({
                    id: fileInfo.id,
                    name: fileInfo.name,
                    mimeType,
                    size: fileInfo.size,
                    kind,
                    extractedText
                });
                continue;
            }

            supported.push({
                id: fileInfo.id,
                name: fileInfo.name,
                mimeType,
                size: fileInfo.size,
                kind,
                base64Data,
                dataUrl: `data:${mimeType};base64,${base64Data}`
            });
        } catch (error) {
            matterMostLog.error({fileId: fileInfo.id, error});
            omitted.push(`${fileInfo.name}（下载或解析失败）`);
        }
    }

    if (fileInfos.length > maxAttachmentCount) {
        omitted.push(`其余 ${fileInfos.length - maxAttachmentCount} 个附件已忽略（超过单条消息附件数量限制）`);
    }

    return {supported, omitted};
}

export async function buildUserMessage(
    userName: string,
    friendlyName: string,
    post: Post
): Promise<OpenAI.Chat.ChatCompletionUserMessageParam> {
    const {supported, omitted} = await resolvePostAttachments(post);
    const prefix = `我的名字是：[${friendlyName}] ${post.message}`.trim();

    if (!supported.length && !omitted.length) {
        return {
            role: 'user',
            name: userName,
            content: prefix
        };
    }

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
        {
            type: 'text',
            text: buildAttachmentText(prefix, supported, omitted)
        }
    ];

    for (const attachment of supported) {
        if (attachment.kind !== 'image' || !attachment.dataUrl) {
            continue;
        }

        content.push({
            type: 'image_url',
            image_url: {
                url: attachment.dataUrl,
                detail: 'auto'
            }
        });
    }

    return {
        role: 'user',
        name: userName,
        content
    };
}

function buildAttachmentText(message: string, supported: ModelAttachment[], omitted: string[]): string {
    const lines: string[] = [message || '用户发送了附件，请结合附件内容回答。'];
    const documentAttachments = supported.filter(attachment => attachment.kind === 'document' && attachment.extractedText);
    const imageAttachments = supported.filter(attachment => attachment.kind === 'image');

    if (imageAttachments.length) {
        lines.push(`已附带图片：${imageAttachments.map(file => file.name).join('，')}`);
    }

    if (documentAttachments.length) {
        lines.push('以下是附件提取出的内容：');
        lines.push(...formatDocumentAttachments(documentAttachments));
    }

    if (omitted.length) {
        lines.push(`未发送给模型的附件：${omitted.join('，')}`);
    }

    return lines.join('\n\n');
}

function formatDocumentAttachment(attachment: ModelAttachment): string {
    return `[附件 ${attachment.name}]\n${attachment.extractedText ?? ''}`;
}

function formatDocumentAttachments(attachments: ModelAttachment[]): string[] {
    let remainingBudget = maxAttachmentTextBudget;
    const formatted: string[] = [];

    for (const attachment of attachments) {
        const block = formatDocumentAttachment(attachment);
        if (block.length <= remainingBudget) {
            formatted.push(block);
            remainingBudget -= block.length;
            continue;
        }

        if (remainingBudget <= 0) {
            formatted.push('[附件内容过长，其余附件已省略]');
            break;
        }

        formatted.push(`${block.slice(0, remainingBudget)}\n\n[附件内容总量超过限制，已截断]`);
        break;
    }

    return formatted;
}

function getAttachmentKind(fileInfo: FileInfo): 'image' | 'document' | undefined {
    const mimeType = (fileInfo.mime_type || '').toLowerCase();
    const extension = (fileInfo.extension || '').toLowerCase();

    if (mimeType.startsWith('image/')) {
        return 'image';
    }

    if (mimeType.startsWith('text/') || textLikeDocumentMimeTypes.has(mimeType) || textLikeDocumentExtensions.has(extension) || officeDocumentExtensions.has(extension)) {
        return 'document';
    }

    return undefined;
}

function inferMimeType(fileInfo: FileInfo): string {
    if (fileInfo.mime_type) {
        return fileInfo.mime_type;
    }

    switch ((fileInfo.extension || '').toLowerCase()) {
        case 'docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'java':
            return 'text/x-java-source';
        case 'js':
            return 'text/javascript';
        case 'json':
            return 'application/json';
        case 'ts':
            return 'text/typescript';
        case 'xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        default:
            return 'text/plain';
    }
}

function extractDocumentText(buffer: Buffer, fileInfo: FileInfo): string | undefined {
    const extension = (fileInfo.extension || '').toLowerCase();

    if (textLikeDocumentExtensions.has(extension) || (fileInfo.mime_type || '').toLowerCase().startsWith('text/') || textLikeDocumentMimeTypes.has((fileInfo.mime_type || '').toLowerCase())) {
        return truncateText(cleanExtractedText(buffer.toString('utf8')), fileInfo.name);
    }

    if (extension === 'docx') {
        return truncateText(extractDocxText(buffer), fileInfo.name);
    }

    if (extension === 'xlsx') {
        return truncateText(extractXlsxText(buffer), fileInfo.name);
    }

    return undefined;
}

function truncateText(text: string | undefined, filename: string): string | undefined {
    if (!text) {
        return undefined;
    }

    const cleaned = cleanExtractedText(text);
    if (!cleaned) {
        return undefined;
    }

    if (cleaned.length <= maxAttachmentTextChars) {
        return cleaned;
    }

    return `${cleaned.slice(0, maxAttachmentTextChars)}\n\n[${filename} 内容过长，已截断]`;
}

function extractDocxText(buffer: Buffer): string | undefined {
    const entries = parseZipEntries(buffer);
    const xmlParts = [...entries.entries()]
        .filter(([name]) => /^word\/(document|header\d+|footer\d+)\.xml$/i.test(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, content]) => content.toString('utf8'));

    if (!xmlParts.length) {
        return undefined;
    }

    return cleanExtractedText(xmlParts.map(xmlToReadableText).join('\n\n'));
}

function extractXlsxText(buffer: Buffer): string | undefined {
    const entries = parseZipEntries(buffer);
    const workbookXml = entries.get('xl/workbook.xml');
    const workbookRelsXml = entries.get('xl/_rels/workbook.xml.rels');

    if (!workbookXml || !workbookRelsXml) {
        return undefined;
    }

    const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
    const sheetTargets = parseWorkbookRelationships(workbookRelsXml.toString('utf8'));
    const sheets = parseWorkbookSheets(workbookXml.toString('utf8')).slice(0, maxSpreadsheetSheets);
    const sheetOutputs: string[] = [];

    for (const sheet of sheets) {
        const target = sheetTargets.get(sheet.relationshipId);
        if (!target) {
            continue;
        }

        const normalizedPath = normalizeWorkbookTarget(target);
        const sheetXml = entries.get(normalizedPath);
        if (!sheetXml) {
            continue;
        }

        const sheetText = parseWorksheetText(sheet.name, sheetXml.toString('utf8'), sharedStrings);
        if (sheetText) {
            sheetOutputs.push(sheetText);
        }
    }

    return cleanExtractedText(sheetOutputs.join('\n\n'));
}

function parseSharedStrings(xml?: string): string[] {
    if (!xml) {
        return [];
    }

    return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map(match => xmlToReadableText(match[0]));
}

function parseWorkbookRelationships(xml: string): Map<string, string> {
    const relationships = new Map<string, string>();

    for (const match of xml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        relationships.set(match[1], match[2]);
    }

    return relationships;
}

function parseWorkbookSheets(xml: string): Array<{name: string, relationshipId: string}> {
    return [...xml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
        .map(match => ({name: decodeXmlEntities(match[1]), relationshipId: match[2]}));
}

function normalizeWorkbookTarget(target: string): string {
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\//, '')}`;
}

function parseWorksheetText(sheetName: string, xml: string, sharedStrings: string[]): string | undefined {
    const rows = new Map<number, string[]>();

    for (const rowMatch of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
        const rowNumber = Number(rowMatch[1]);
        const rowValues = rows.get(rowNumber) ?? [];

        for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const attributes = cellMatch[1];
            const cellBody = cellMatch[2];
            const cellRef = /r="([A-Z]+)\d+"/.exec(attributes)?.[1];
            if (!cellRef) {
                continue;
            }

            const columnIndex = excelColumnToIndex(cellRef);
            if (columnIndex >= maxSpreadsheetCols) {
                continue;
            }

            rowValues[columnIndex] = parseWorksheetCellValue(attributes, cellBody, sharedStrings);
        }

        rows.set(rowNumber, rowValues);
        if (rows.size >= maxSpreadsheetRows) {
            break;
        }
    }

    if (!rows.size) {
        return undefined;
    }

    const orderedRows = [...rows.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, values]) => values.slice(0, maxSpreadsheetCols).map(value => (value ?? '').replace(/\t/g, ' ')).join('\t').trimEnd())
        .filter(line => line.length > 0);

    if (!orderedRows.length) {
        return undefined;
    }

    return `[工作表 ${sheetName}]\n${orderedRows.join('\n')}`;
}

function parseWorksheetCellValue(attributes: string, body: string, sharedStrings: string[]): string {
    const type = /t="([^"]+)"/.exec(attributes)?.[1];
    const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
    const inlineString = /<is\b[\s\S]*?<\/is>/.exec(body)?.[0];
    const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';

    if (inlineString) {
        return cleanExtractedText(xmlToReadableText(inlineString));
    }

    if (type === 's') {
        const sharedIndex = Number(value);
        return sharedStrings[sharedIndex] ?? '';
    }

    if (type === 'b') {
        return value === '1' ? 'TRUE' : 'FALSE';
    }

    if (formula) {
        return `${decodeXmlEntities(formula)} = ${decodeXmlEntities(value)}`.trim();
    }

    return decodeXmlEntities(value);
}

function excelColumnToIndex(column: string): number {
    let result = 0;

    for (const char of column) {
        result = result * 26 + (char.charCodeAt(0) - 64);
    }

    return result - 1;
}

function parseZipEntries(buffer: Buffer): Map<string, Buffer> {
    const eocdOffset = findEndOfCentralDirectory(buffer);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const entries = new Map<string, Buffer>();

    let offset = centralDirectoryOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            break;
        }

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraFieldLength = buffer.readUInt16LE(offset + 30);
        const fileCommentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');

        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressedData = buffer.slice(dataStart, dataStart + compressedSize);

        entries.set(name, decompressZipEntry(compressionMethod, compressedData));
        offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }

    return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset--) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }

    throw new Error('ZIP central directory not found.');
}

function decompressZipEntry(compressionMethod: number, compressedData: Buffer): Buffer {
    if (compressionMethod === 0) {
        return compressedData;
    }

    if (compressionMethod === 8) {
        return inflateRawSync(compressedData);
    }

    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function xmlToReadableText(xml: string): string {
    return decodeXmlEntities(
        xml
            .replace(/<w:tab\/>/g, '\t')
            .replace(/<w:br\/>/g, '\n')
            .replace(/<w:cr\/>/g, '\n')
            .replace(/<\/w:p>/g, '\n')
            .replace(/<\/w:tr>/g, '\n')
            .replace(/<\/w:tc>/g, '\t')
            .replace(/<[^>]+>/g, ' ')
    );
}

function cleanExtractedText(text: string): string {
    return text
        .replace(/\u0000/g, '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

async function downloadMattermostFile(fileInfo: FileInfo): Promise<Buffer> {
    const fileUrl = mmClient.getFileUrl(fileInfo.id, fileInfo.update_at);
    const response = await fetch(fileUrl, {
        headers: {
            Authorization: `Bearer ${mattermostToken}`
        }
    });

    if (!response.ok) {
        matterMostLog.error({fileId: fileInfo.id, status: response.status, statusText: response.statusText});
        throw new Error(`Failed to download Mattermost attachment ${fileInfo.id}`);
    }

    return Buffer.from(await response.arrayBuffer());
}
