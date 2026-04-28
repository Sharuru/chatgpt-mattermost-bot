import {PluginBase} from "./PluginBase";
import {AiResponse, MessageData} from "../types";
import OpenAI from 'openai';
import {ModelAttachment, resolvePostAttachments} from "../attachment-utils";
import {createChatCompletion, createImage} from "../openai-wrapper";
import {uploadFileToMattermost} from "../mm-client";

type ImagePluginArgs = {
    imageDescription: string
}

export class ImagePlugin extends PluginBase<ImagePluginArgs> {
    private readonly supportedReferenceMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    private readonly GPT_INSTRUCTIONS = "你是一位 AI 的 prompt 工程师，帮助用户创建优质的 AI 图片生成提示。" + 
    "用户会提供简短的图像描述，你需要将其转化为合适的提示文本。" + 
    "创建提示时，首先描述图像的外观和结构。其次，描述摄影风格，如相机角度、相机位置、镜头等。第三，描述光线和特定颜色。" + 
    "你的提示必须专注于整体图像，而不是描述其中的细节。" + 
    "如果用户没有提供，考虑添加一些流行词，例如'细节丰富'、'超细节'、'非常逼真'、'素描风格'、'街头艺术'、'绘画'等类似词语。" + 
    "用户可能更偏爱日本动漫、卡通的风格的图片。" +
    "保持提示尽可能简单，且不超过400个字符。你只能回答生成的提示，不提供任何描述或解释。" +
    "并记住一定要使用与收到的描述相同的语种。比如用户的描述是中文，那么你的提示也应该是中文。" +
    "如果你无法分辨或不确信用户的描述语种，那默认使用简体中文。"

    setup(): boolean {
        this.addPluginArgument('imageDescription', 'string', '用户提供的描述')

        const plugins = process.env["PLUGINS"];
        if(!plugins || plugins.indexOf('image-plugin') === -1)
            return false

        return super.setup();
    }

    async runPlugin(args: ImagePluginArgs, msgData: MessageData): Promise<AiResponse> {
        const aiResponse: AiResponse = {
            message: "发生了内部错误"
        }

        try {
            const referenceImages = (await resolvePostAttachments(msgData.post)).supported
                .filter((attachment): attachment is ModelAttachment & {base64Data: string, dataUrl: string} =>
                    attachment.kind === 'image' &&
                    !!attachment.base64Data &&
                    !!attachment.dataUrl &&
                    this.supportedReferenceMimeTypes.has(attachment.mimeType.toLowerCase())
                );
            let imagePrompt;
            const msgText = msgData.post.message;
            if(msgText.startsWith("[直接生成图片]") || msgText.includes("[直接生成图片]")) {
                imagePrompt = msgText.split("[直接生成图片]")[1].trim();
            }else {
                imagePrompt = await this.createImagePrompt(args.imageDescription)
            }
            if(imagePrompt) {
                this.log.trace({imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt})
                const base64Image = await createImage(imagePrompt, referenceImages)
                if(base64Image) {
                    const fileId = await this.base64ToFile(base64Image, msgData.post.channel_id)
                    aiResponse.message = "" + imagePrompt
                    aiResponse.props = {originalMessage: "<IMAGE>" + imagePrompt + "</IMAGE>"}
                    aiResponse.fileId = fileId
                }
            }
        } catch (e) {
            this.log.error(e)
            this.log.error(`The input was:\n\n${args.imageDescription}`)
        }

       return aiResponse
    }

    async createImagePrompt(userInput: string): Promise<string | undefined> {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            {
                role: 'system',
                content: this.GPT_INSTRUCTIONS
            },
            {
                role: 'user',
                content: userInput
            }
        ]

        const response = await createChatCompletion(messages)
        
        return response?.content ?? undefined
    }

    async base64ToFile (b64String: string, channelId: string) {
        const response = await uploadFileToMattermost(
            channelId,
            Buffer.from(b64String, 'base64'),
            'image.png',
            'image/png'
        );
        this.log.trace('Uploaded a file with id', response.file_infos[0].id)
        return response.file_infos[0].id
    }
}
