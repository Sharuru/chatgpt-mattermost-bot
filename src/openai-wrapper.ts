import OpenAI, {toFile} from 'openai';
import {openAILog as log} from "./logging";
import {PluginBase} from "./plugins/PluginBase";
import {AiResponse, MessageData} from "./types";
import {USER_FACING_ERROR_MESSAGE} from "./error-messages";
import type {LightRagMode} from "./command-router";
import {ImageOutputSize, normalizeImageOutputSize, PreparedReferenceImage} from "./image-utils";

const apiKey = process.env['OPENAI_API_KEY'];
const basePath = process.env['OPENAI_API_BASE'];
log.trace({apiKey, basePath});

const openai = new OpenAI({
    apiKey,
    baseURL: basePath
});

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-4.1';
const max_tokens = Number(process.env['OPENAI_MAX_TOKENS'] ?? 8192);
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1);
const imageModel = process.env['OPENAI_IMAGE_MODEL'] ?? 'gpt-image-2';
const imageEditModel = process.env['OPENAI_IMAGE_EDIT_MODEL'] ?? imageModel;
const imageSize = normalizeImageOutputSize(process.env['OPENAI_IMAGE_SIZE']);
const lightRagBaseUrl = process.env['LIGHTRAG_BASE_URL'];
const lightRagApiKey = process.env['LIGHTRAG_API_KEY'];
const lightRagModel = process.env['LIGHTRAG_MODEL'] ?? 'lightrag:latest';
const lightRagDefaultMode = normalizeLightRagMode(process.env['LIGHTRAG_DEFAULT_MODE']);
const webSearchToolType = normalizeWebSearchToolType(process.env['OPENAI_WEB_SEARCH_TOOL']);
const webSearchContextSize = normalizeWebSearchContextSize(process.env['OPENAI_WEB_SEARCH_CONTEXT_SIZE']);

// Image generation configuration
const imageQuality = normalizeImageQuality(process.env['OPENAI_IMAGE_QUALITY']);
log.debug({model, max_tokens, temperature, imageModel, imageEditModel, imageQuality});

const plugins: Map<string, PluginBase<any>> = new Map();
const functions: OpenAI.Chat.ChatCompletionCreateParams.Function[] = [];

export function registerChatPlugin(plugin: PluginBase<any>) {
    plugins.set(plugin.key, plugin);
    functions.push({
        name: plugin.key,
        description: plugin.description,
        parameters: {
            type: 'object',
            properties: plugin.pluginArguments,
            required: plugin.requiredArguments
        }
    });
}

export async function continueThread(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    msgData: MessageData
): Promise<AiResponse> {
    let aiResponse: AiResponse = {
        message: USER_FACING_ERROR_MESSAGE
    };

    let maxChainLength = 7;
    const missingPlugins = new Set<string>();

    let isIntermediateResponse = true;
    while(isIntermediateResponse && maxChainLength-- > 0) {
        const responseMessage = await createChatCompletion(messages, functions);
        log.trace(responseMessage);
        
        if(responseMessage) {
            if(responseMessage.function_call) {
                const pluginName = responseMessage.function_call.name;
                log.trace({pluginName});
                try {
                    const plugin = plugins.get(pluginName);
                    if (plugin) {
                        const pluginArguments = JSON.parse(responseMessage.function_call.arguments ?? '[]');
                        log.trace({plugin, pluginArguments});
                        const pluginResponse = await plugin.runPlugin(pluginArguments, msgData);
                        log.trace({pluginResponse});

                        if(pluginResponse.intermediate) {
                            messages.push({
                                role: 'function',
                                name: pluginName,
                                content: pluginResponse.message
                            });
                            continue;
                        }
                        aiResponse = pluginResponse;
                    } else {
                        if (!missingPlugins.has(pluginName)){
                            missingPlugins.add(pluginName);
                            log.debug({ error: 'Missing plugin ' + pluginName, pluginArguments: responseMessage.function_call.arguments});
                            messages.push({ role: 'system', content: `There is no plugin named '${pluginName}' available. Try without using that plugin.`});
                            continue;
                        } else {
                            log.debug({ messages });
                            aiResponse.message = USER_FACING_ERROR_MESSAGE;
                        }
                    }
                } catch (e) {
                    log.debug({ messages, error: e });
                    aiResponse.message = USER_FACING_ERROR_MESSAGE;
                }
            } else if(responseMessage.content) {
                // filter think blocks
                let content = responseMessage.content;
                
                // Replace everything before and including </think> and the two newlines after it
                if (content.includes('</think>')) {
                    log.trace("Removing think block");
                    content = content.split('</think>\n\n')[1];
                    log.trace("New content: " + content);
                }
                
                aiResponse.message = content;
            }
        }

        isIntermediateResponse = false;
    }

    return aiResponse;
}

export async function createChatCompletion(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    functions?: OpenAI.Chat.ChatCompletionCreateParams.Function[]
): Promise<OpenAI.Chat.ChatCompletionMessage | undefined> {
    const chatCompletionOptions: OpenAI.Chat.ChatCompletionCreateParams = {
        model: model,
        messages: messages,
        max_tokens: max_tokens,
        temperature: temperature,
    };

    if(functions?.length) {
        chatCompletionOptions.functions = functions;
        chatCompletionOptions.function_call = 'auto';
    }

    log.trace({chatCompletionOptions});

    try {
        const chatCompletion = await openai.chat.completions.create(chatCompletionOptions);
        log.trace({chatCompletion});
        return chatCompletion.choices[0].message;
    } catch (error) {
        log.error('Error creating chat completion:', error);
        return undefined;
    }
}

export async function createWebSearchResponse(
    prompt: string,
    options: {
        instructions: string,
        forceSearch?: boolean
    }
): Promise<{message: string} | undefined> {
    try {
        const response = await openai.responses.create({
            model,
            input: prompt,
            instructions: options.instructions,
            max_output_tokens: max_tokens,
            tool_choice: options.forceSearch ? 'required' : undefined,
            tools: [
                {
                    type: webSearchToolType as any,
                    search_context_size: webSearchContextSize
                }
            ]
        });
        log.trace({response});
        return {
            message: response.output_text
        };
    } catch (error) {
        log.error('Error creating web search response:', error);
        return undefined;
    }
}

export async function createLightRagResponse(
    prompt: string,
    mode?: LightRagMode
): Promise<string | undefined> {
    if (!lightRagBaseUrl) {
        log.error('LIGHTRAG_BASE_URL is not configured.');
        return undefined;
    }

    const selectedMode = mode ?? lightRagDefaultMode;
    const lightRagPrompt = selectedMode ? `/${selectedMode} ${prompt}` : prompt;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };

    if (lightRagApiKey) {
        headers.Authorization = `Bearer ${lightRagApiKey}`;
    }

    try {
        const response = await fetch(`${lightRagBaseUrl.replace(/\/$/, '')}/api/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: lightRagModel,
                messages: [
                    {
                        role: 'user',
                        content: lightRagPrompt
                    }
                ],
                stream: false
            })
        });

        if (!response.ok) {
            log.error('Error creating LightRAG response:', {
                status: response.status,
                statusText: response.statusText,
                body: await response.text()
            });
            return undefined;
        }

        const result = await response.json() as {
            message?: {content?: string},
            response?: string,
            choices?: Array<{message?: {content?: string}}>
        };

        return result.message?.content ?? result.response ?? result.choices?.[0]?.message?.content;
    } catch (error) {
        log.error('Error creating LightRAG response:', error);
        return undefined;
    }
}

export async function createImage(
    prompt: string,
    referenceImages: PreparedReferenceImage[] = []
): Promise<string | undefined> {
    try {
        const referenceFiles = await Promise.all(referenceImages.map(createReferenceImageFile));
        const size = chooseImageSize(referenceImages);
        const image = referenceImages.length
            ? await openai.images.edit({
                model: imageEditModel,
                image: referenceFiles.length === 1 ? referenceFiles[0] : referenceFiles,
                prompt,
                quality: imageQuality,
                size,
                n: 1
            })
            : await openai.images.generate({
                model: imageModel,
                prompt,
                quality: imageQuality,
                size,
                n: 1,
                response_format: 'b64_json'
            });
        
        // Check if image data exists
        if (!image.data || image.data.length === 0) {
            log.error('No image data returned from API');
            return undefined;
        }
        
        // Create a safe copy for logging without the base64 data
        const safeImageForLogging = {
            ...image,
            data: image.data.map(item => ({
                ...item,
                b64_json: item.b64_json ? 'OMITTED' : undefined
            }))
        };
        log.trace({ image: safeImageForLogging });
        
        if (image.data[0].b64_json) {
            return image.data[0].b64_json;
        }

        if (image.data[0].url) {
            const response = await fetch(image.data[0].url);
            if (!response.ok) {
                log.error('Failed to download generated image from URL', {status: response.status, statusText: response.statusText});
                return undefined;
            }
            return Buffer.from(await response.arrayBuffer()).toString('base64');
        }

        return undefined;
    } catch (error) {
        log.error('Error creating image:', error);
        return undefined;
    }
}

async function createReferenceImageFile(image: PreparedReferenceImage) {
    return toFile(
        image.buffer,
        image.name,
        {type: image.mimeType}
    );
}

function normalizeImageQuality(value: string | undefined): 'auto' | 'standard' | 'low' | 'medium' | 'high' {
    switch ((value ?? 'auto').toLowerCase()) {
        case 'hd':
            return 'high';
        case 'high':
        case 'low':
        case 'medium':
        case 'standard':
            return value!.toLowerCase() as 'high' | 'low' | 'medium' | 'standard';
        default:
            return 'auto';
    }
}

function normalizeLightRagMode(value: string | undefined): LightRagMode | undefined {
    switch ((value ?? '').toLowerCase()) {
        case 'local':
        case 'global':
        case 'hybrid':
        case 'naive':
        case 'mix':
        case 'context':
            return value!.toLowerCase() as LightRagMode;
        default:
            return undefined;
    }
}

function normalizeWebSearchToolType(value: string | undefined): 'web_search' | 'web_search_preview' {
    switch ((value ?? 'web_search').toLowerCase()) {
        case 'web_search_preview':
        case 'preview':
            return 'web_search_preview';
        default:
            return 'web_search';
    }
}

function normalizeWebSearchContextSize(value: string | undefined): 'low' | 'medium' | 'high' {
    switch ((value ?? 'medium').toLowerCase()) {
        case 'low':
        case 'high':
            return value!.toLowerCase() as 'low' | 'high';
        default:
            return 'medium';
    }
}

function chooseImageSize(referenceImages: PreparedReferenceImage[]): ImageOutputSize {
    if (imageSize !== 'match-reference') {
        return imageSize;
    }

    if (!referenceImages.length) {
        return 'auto';
    }

    const primary = referenceImages[0];
    if (!primary.width || !primary.height) {
        return 'auto';
    }

    const ratio = primary.width / primary.height;
    if (ratio >= 1.2) {
        return '1536x1024';
    }
    if (ratio <= 0.83) {
        return '1024x1536';
    }
    return '1024x1024';
}
