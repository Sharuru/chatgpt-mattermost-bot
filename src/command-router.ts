import {Post} from "@mattermost/types/lib/posts";
import {createLightRagResponse, createWebSearchResponse} from "./openai-wrapper";
import {createImagePromptAndFile} from "./plugins/ImagePlugin";
import {AiResponse} from "./types";
import {getThreadId, muteThread, unmuteThread} from "./thread-state";
import {USER_FACING_ERROR_MESSAGE} from "./error-messages";
import {createWebsiteScreenshots} from "./screenshot-utils";

export type BotCommand =
    | {type: 'search', prompt: string, force: boolean, screenshots: boolean, screenshotLimit: number}
    | {type: 'image', prompt: string, raw: boolean}
    | {type: 'rag', prompt: string, mode?: LightRagMode}
    | {type: 'leave'}
    | {type: 'join'};

export type LightRagMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix' | 'context';

const supportedLightRagModes = new Set<LightRagMode>(['local', 'global', 'hybrid', 'naive', 'mix', 'context']);
const defaultScreenshotLimit = Number(process.env['WEB_SEARCH_SCREENSHOT_LIMIT'] ?? 3);

export function parseBotCommand(message: string, botName: string): BotCommand | undefined {
    const normalized = stripLeadingBotMention(message.trim(), botName);
    if (!normalized.startsWith('/')) {
        return undefined;
    }

    const [command, ...restParts] = normalized.split(/\s+/);
    const rest = restParts.join(' ').trim();

    switch (command.toLowerCase()) {
        case '/search':
            return parseSearchCommand(rest);
        case '/image':
            return parseImageCommand(rest);
        case '/rag':
            return parseLightRagCommand(rest);
        case '/leave':
        case '/mute-thread':
            return {type: 'leave'};
        case '/join':
            return {type: 'join'};
        default:
            return undefined;
    }
}

export async function runBotCommand(command: BotCommand, post: Post, botInstructions: string): Promise<AiResponse> {
    switch (command.type) {
        case 'search':
            const searchResult = await createWebSearchResponse(command.prompt, botInstructions, command.screenshots, command.force);
            if (!searchResult) {
                return {message: USER_FACING_ERROR_MESSAGE};
            }

            if (!command.screenshots) {
                return {
                    message: searchResult.message,
                    props: {originalMessage: post.message}
                };
            }

            const screenshotResult = await createWebsiteScreenshots(
                post.channel_id,
                searchResult.urls.slice(0, command.screenshotLimit)
            );
            const sourceText = searchResult.urls.length
                ? `\n\n引用 URL：\n${searchResult.urls.slice(0, command.screenshotLimit).map((url, index) => `${index + 1}. ${url}`).join('\n')}`
                : "";
            const screenshotText = screenshotResult.omitted.length
                ? `\n\n截图失败：${screenshotResult.omitted.join('，')}`
                : "";
            const noUrlsText = searchResult.urls.length
                ? ""
                : "\n\n未生成截图：模型未使用网络搜索，或搜索结果未返回可截图的引用 URL。";

            return {
                message: `${searchResult.message}${sourceText}${screenshotText}${noUrlsText}`,
                fileIds: screenshotResult.fileIds,
                props: {originalMessage: post.message}
            };
        case 'image':
            return createImagePromptAndFile(command.prompt, post, command.raw);
        case 'rag':
            return {
                message: await createLightRagResponse(command.prompt, command.mode) ?? USER_FACING_ERROR_MESSAGE,
                props: {originalMessage: post.message}
            };
        case 'leave':
            muteThread(getThreadId(post));
            return {
                message: "我已退出这个线程，之后不会再自动回复。需要我回来时，请在这个线程里发送 `/join`。"
            };
        case 'join':
            unmuteThread(getThreadId(post));
            return {
                message: "我已回到这个线程，后续可以继续回复。"
            };
    }
}

function parseSearchCommand(input: string): BotCommand | undefined {
    let rest = input.trim();
    let force = false;
    let screenshots = false;
    let screenshotLimit = defaultScreenshotLimit;

    const forceMatch = rest.match(/(?:^|\s)--force(?:\s|$)/);
    if (forceMatch) {
        force = true;
        rest = rest.replace(/(?:^|\s)--force(?:\s|$)/, ' ').trim();
    }

    const screenshotMatch = rest.match(/(?:^|\s)--screenshot(?:\s|$)/);
    if (screenshotMatch) {
        screenshots = true;
        rest = rest.replace(/(?:^|\s)--screenshot(?:\s|$)/, ' ').trim();
    }

    const limitMatch = rest.match(/(?:^|\s)--limit\s+(\d+)(?:\s|$)/);
    if (limitMatch) {
        screenshotLimit = Math.min(3, Math.max(1, Number(limitMatch[1])));
        rest = rest.replace(/(?:^|\s)--limit\s+\d+(?:\s|$)/, ' ').trim();
    }

    if (!rest) {
        return undefined;
    }

    return {
        type: 'search',
        prompt: rest,
        force,
        screenshots,
        screenshotLimit: Math.min(3, Math.max(1, screenshotLimit))
    };
}

export function isJoinCommand(message: string, botName: string): boolean {
    return parseBotCommand(message, botName)?.type === 'join';
}

function parseImageCommand(input: string): BotCommand | undefined {
    const raw = input.startsWith('--raw ');
    const prompt = raw ? input.slice('--raw '.length).trim() : input.trim();
    return prompt ? {type: 'image', prompt, raw} : undefined;
}

function parseLightRagCommand(input: string): BotCommand | undefined {
    const modeMatch = input.match(/^--mode\s+([a-z]+)\s+([\s\S]+)$/i);
    if (!modeMatch) {
        return input ? {type: 'rag', prompt: input} : undefined;
    }

    const mode = modeMatch[1].toLowerCase() as LightRagMode;
    const prompt = modeMatch[2].trim();
    if (!prompt || !supportedLightRagModes.has(mode)) {
        return undefined;
    }

    return {type: 'rag', prompt, mode};
}

function stripLeadingBotMention(message: string, botName: string): string {
    const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return message.replace(new RegExp(`^${escapedName}\\s+`, 'i'), '').trim();
}
