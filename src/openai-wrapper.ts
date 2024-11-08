import OpenAI from 'openai';
import {openAILog as log} from "./logging";
import {PluginBase} from "./plugins/PluginBase";
import {AiResponse, MessageData} from "./types";

const apiKey = process.env['OPENAI_API_KEY'];
const basePath = process.env['OPENAI_API_BASE'];
log.trace({apiKey, basePath});

// 创建 OpenAI 实例
const openai = new OpenAI({
    apiKey,
    baseURL: basePath
});

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-3.5-turbo';
const max_tokens = Number(process.env['OPENAI_MAX_TOKENS'] ?? 2000);
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1);

log.debug({model, max_tokens, temperature});

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
                aiResponse.message = responseMessage.content;
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
        const image = await openai.images.generate({
            model: "dall-e-3",
            prompt,
            n: 1,
            quality: 'standard',
            style: 'vivid',
            size: '1024x1024',
            response_format: 'b64_json'
        });
        
        log.trace({image});
        return image.data[0].b64_json;
    } catch (error) {
        log.error('Error creating image:', error);
        return undefined;
    }
}
