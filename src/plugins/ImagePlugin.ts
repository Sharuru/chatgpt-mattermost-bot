import {PluginBase} from "./PluginBase";
import {AiResponse, MessageData} from "../types";
import {ChatCompletionRequestMessageRoleEnum} from "openai";
import {createChatCompletion, createImage} from "../openai-wrapper";
import FormData from "form-data";
import {mmClient} from "../mm-client";

type ImagePluginArgs = {
    imageDescription: string
}

export class ImagePlugin extends PluginBase<ImagePluginArgs> {
    private readonly GPT_INSTRUCTIONS = "你是一位 AI 的 prompt 工程师，帮助用户为图像AI DALL-E创建优质提示。" + 
    "用户会提供简短的图像描述，你需要将其转化为合适的提示文本。" + 
    "你的主要任务是将描述变成英文" +
    "保持提示尽可能简单，且不超过400个字符。你只能回答生成的提示，不提供任何描述或解释" + 
    "最后你生成的 prompt 应该是英文的，并在最后加上 " + 
    " --version 6 --quality 1 --chaos 0 --stylize 100" +
    " 的固定参数"


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
            this.log.error(`The input was:\n\n${prompt}`)
        }

       return aiResponse
    }

    async createImagePrompt(userInput: string): Promise<string | undefined> {
        const messages = [
            {
                role: ChatCompletionRequestMessageRoleEnum.System,
                content: this.GPT_INSTRUCTIONS
            },
            {
                role: ChatCompletionRequestMessageRoleEnum.User,
                content: userInput
            }
        ]

        const response = await createChatCompletion(messages)
        return response?.content
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