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

export async function createBotPosts(args: CreateBotPostArgs): Promise<Post[]> {
    const messageParts = splitMattermostMessage(cleanMattermostMessage(args.message));
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

function splitMattermostMessage(message: string): string[] {
    if (message.length <= maxPostChars) {
        return [message];
    }

    const parts: string[] = [];
    let rest = message;

    while (rest.length > maxPostChars) {
        const splitAt = findSplitPoint(rest, maxPostChars);
        parts.push(rest.slice(0, splitAt).trimEnd());
        rest = rest.slice(splitAt).trimStart();
    }

    if (rest.length) {
        parts.push(rest);
    }

    return parts.map((part, index) => parts.length > 1
        ? `${part}\n\n（续 ${index + 1}/${parts.length}）`
        : part
    );
}

function findSplitPoint(message: string, limit: number): number {
    const candidates = [
        message.lastIndexOf('\n\n', limit),
        message.lastIndexOf('\n', limit),
        message.lastIndexOf('。', limit),
        message.lastIndexOf('.', limit),
        message.lastIndexOf(' ', limit)
    ].filter(index => index > limit * 0.5);

    return candidates.length ? Math.max(...candidates) + 1 : limit;
}
