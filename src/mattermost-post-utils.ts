import {Post} from "@mattermost/types/lib/posts";
import {mmClient} from "./mm-client";
import {botLog} from "./logging";

type CreateBotPostArgs = {
    message: string,
    channelId: string,
    rootId: string,
    props?: Record<string, string>,
    fileIds?: string[]
}

const maxPostChars = Number(process.env['MATTERMOST_MAX_POST_CHARS'] ?? 12000);
const maxPostBytes = Number(process.env['MATTERMOST_MAX_POST_BYTES'] ?? maxPostChars);
const retryPostBytes = Number(process.env['MATTERMOST_RETRY_POST_BYTES'] ?? 4000);

export async function createBotPosts(args: CreateBotPostArgs): Promise<Post[]> {
    const message = cleanMattermostMessage(args.message);
    const messageParts = splitMattermostMessage(message, maxPostBytes);

    try {
        return await createSplitPosts(args, messageParts);
    } catch (error) {
        botLog.error({message: 'Failed to create split Mattermost posts. Retrying with smaller chunks.', error});
        return createSplitPosts(
            {
                ...args,
                props: undefined,
                fileIds: undefined
            },
            splitMattermostMessage(message, retryPostBytes)
        );
    }
}

async function createSplitPosts(args: CreateBotPostArgs, messageParts: string[]): Promise<Post[]> {
    const posts: Post[] = [];

    for (let index = 0; index < messageParts.length; index++) {
        const isFirstPart = index === 0;
        const post = await mmClient.createPost({
            message: messageParts[index],
            channel_id: args.channelId,
            props: isFirstPart ? args.props : undefined,
            root_id: args.rootId,
            file_ids: isFirstPart && args.fileIds?.length ? args.fileIds : undefined
        });
        posts.push(post);
        botLog.trace({msg: post});
    }

    return posts;
}

function cleanMattermostMessage(message: string): string {
    return (message || "")
        .replace(/\u0000/g, '')
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim() || " ";
}

function splitMattermostMessage(message: string, maxBytes: number): string[] {
    if (Buffer.byteLength(message, 'utf8') <= maxBytes) {
        return [message];
    }

    const parts: string[] = [];
    let rest = message;

    while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
        const splitAt = findSplitPoint(rest, maxBytes);
        parts.push(rest.slice(0, splitAt).trimEnd());
        rest = rest.slice(splitAt).trimStart();
    }

    if (rest.length) {
        parts.push(rest);
    }

    return parts.map((part, index) => {
        if (parts.length <= 1) {
            return part;
        }

        const suffix = `\n\n（续 ${index + 1}/${parts.length}）`;
        const suffixBytes = Buffer.byteLength(suffix, 'utf8');
        if (Buffer.byteLength(part + suffix, 'utf8') <= maxBytes) {
            return `${part}${suffix}`;
        }

        return `${trimToUtf8Bytes(part, Math.max(1, maxBytes - suffixBytes))}${suffix}`;
    });
}

function findSplitPoint(message: string, byteLimit: number): number {
    const limit = findUtf8CodeUnitLimit(message, byteLimit - 64);
    const candidates = [
        message.lastIndexOf('\n\n', limit),
        message.lastIndexOf('\n', limit),
        message.lastIndexOf('。', limit),
        message.lastIndexOf('.', limit),
        message.lastIndexOf(' ', limit)
    ].filter(index => index > limit * 0.5);

    return candidates.length ? Math.max(...candidates) + 1 : limit;
}

function findUtf8CodeUnitLimit(message: string, byteLimit: number): number {
    let bytes = 0;
    let codeUnitIndex = 0;

    for (const char of message) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (bytes + charBytes > byteLimit) {
            break;
        }

        bytes += charBytes;
        codeUnitIndex += char.length;
    }

    return Math.max(1, codeUnitIndex);
}

function trimToUtf8Bytes(message: string, byteLimit: number): string {
    return message.slice(0, findUtf8CodeUnitLimit(message, byteLimit)).trimEnd();
}
