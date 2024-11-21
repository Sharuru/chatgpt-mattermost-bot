import {PluginBase} from "./PluginBase";
import {AiResponse, MessageData} from "../types";
import OpenAI from 'openai';
import {createChatCompletion, createImage} from "../openai-wrapper";
import FormData from "form-data";
import {mmClient} from "../mm-client";

type ImagePluginArgs = {
    imageDescription: string
}

export class ImagePlugin extends PluginBase<ImagePluginArgs> {
    private readonly GPT_INSTRUCTIONS = "你是一位 AI 的 prompt 工程师，帮助用户为图像AI DALL-E创建优质提示。" + 
    "用户会提供简短的图像描述，你需要将其转化为合适的提示文本。" + 
    "创建提示时，首先描述图像的外观和结构。其次，描述摄影风格，如相机角度、相机位置、镜头等。第三，描述光线和特定颜色。" + 
    "你的提示必须专注于整体图像，而不是描述其中的细节。" + 
    "如果用户没有提供，考虑添加一些流行词，例如'细节丰富'、'超细节'、'非常逼真'、'素描风格'、'街头艺术'、'绘画'等类似词语。" + 
    "保持提示尽可能简单，且不超过400个字符。你只能回答生成的提示，不提供任何描述或解释。" +
    "当然，如果用户的描述以【无需帮助】开头，那么你就不要进行任何转化处理，去除掉【无需帮助】后直接将剩余内容作为转化后的提示即可。" +
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
            const imagePrompt = await this.createImagePrompt(args.imageDescription)
            if(imagePrompt) {
                this.log.trace({imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt})
                const base64Image = await createImage(imagePrompt)
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
        const form = new FormData()
        form.append('channel_id', channelId);
        form.append('files', Buffer.from(b64String, 'base64'), 'image.png');
        const response = await mmClient.uploadFile(form)
        this.log.trace('Uploaded a file with id', response.file_infos[0].id)
        return response.file_infos[0].id
    }
}
