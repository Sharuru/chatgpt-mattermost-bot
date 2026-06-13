import {Post} from "@mattermost/types/lib/posts";
import {createLightRagResponse, createWebSearchResponse} from "./openai-wrapper";
import {createImagePromptAndFile} from "./plugins/ImagePlugin";
import {AiResponse} from "./types";
import {getThreadId, muteThread, unmuteThread} from "./thread-state";
import {USER_FACING_ERROR_MESSAGE} from "./error-messages";

export type BotCommand =
    | {type: 'search', prompt: string}
    | {type: 'image', prompt: string, raw: boolean}
    | {type: 'rag', prompt: string, mode?: LightRagMode}
    | {type: 'leave'}
    | {type: 'join'};

export type LightRagMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix' | 'context';

const supportedLightRagModes = new Set<LightRagMode>(['local', 'global', 'hybrid', 'naive', 'mix', 'context']);

export function parseBotCommand(message: string, botName: string): BotCommand | undefined {
    const normalized = stripLeadingBotMention(message.trim(), botName);
    if (!normalized.startsWith('/')) {
        return undefined;
    }

    const [command, ...restParts] = normalized.split(/\s+/);
    const rest = restParts.join(' ').trim();

    switch (command.toLowerCase()) {
        case '/search':
            return rest ? {type: 'search', prompt: rest} : undefined;
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
            return {
                message: await createWebSearchResponse(command.prompt, botInstructions) ?? USER_FACING_ERROR_MESSAGE,
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
