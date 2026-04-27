import OpenAI from 'openai';
import {openAILog as log} from "./logging";
import {PluginBase} from "./plugins/PluginBase";
import {AiResponse, MessageData} from "./types";
import 'isomorphic-fetch';

// Add Blob polyfill for Node.js environments
if (typeof global.Blob === 'undefined') {
    const { Blob } = require('buffer');
    global.Blob = Blob;
}

const apiKey = process.env['OPENAI_API_KEY'];
const basePath = process.env['OPENAI_API_BASE'];
log.trace({apiKey, basePath});

const openai = new OpenAI({
    apiKey,
    baseURL: basePath,
    fetch: fetch
});

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-4.1';
const max_tokens = Number(process.env['OPENAI_MAX_TOKENS'] ?? 8192);
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1);

// Image generation configuration
const imageQuality = (process.env['OPENAI_IMAGE_QUALITY'] ?? 'auto') as 'medium' | 'auto' | 'standard' | 'hd' | 'low' | 'high';
log.debug({model, max_tokens, temperature, imageQuality});

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
        message: 'Sorry, but it seems I found no valid response.'
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
                            aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
                        }
                    }
                } catch (e) {
                    log.debug({ messages, error: e });
                    aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
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

export async function createImage(prompt: string): Promise<string | undefined> {
    try {
        // Use GPT-IMAGE-2 for image generation
        const image = await openai.images.generate({
            model: "gpt-image-2",
            prompt,
            quality: imageQuality,
            size: '1024x1024',
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
        
        return image.data[0].b64_json;
    } catch (error) {
        log.error('Error creating image:', error);
        return undefined;
    }
}
