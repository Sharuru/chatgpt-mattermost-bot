import {chromium} from "playwright-core";
import {uploadFileToMattermost} from "./mm-client";
import {botLog} from "./logging";

export type ScreenshotResult = {
    fileIds: string[],
    omitted: string[]
}

const screenshotTimeoutMs = Number(process.env['WEB_SEARCH_SCREENSHOT_TIMEOUT_MS'] ?? 8000);
const screenshotViewportWidth = Number(process.env['WEB_SEARCH_SCREENSHOT_WIDTH'] ?? 1365);
const screenshotViewportHeight = Number(process.env['WEB_SEARCH_SCREENSHOT_HEIGHT'] ?? 768);
const chromiumExecutablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] || defaultChromiumExecutablePath();

export async function createWebsiteScreenshots(channelId: string, urls: string[]): Promise<ScreenshotResult> {
    const fileIds: string[] = [];
    const omitted: string[] = [];

    if (!urls.length) {
        return {fileIds, omitted};
    }

    let browser;
    try {
        browser = await chromium.launch({
            executablePath: chromiumExecutablePath,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            try {
                const buffer = await captureWebsiteScreenshot(browser, url);
                const upload = await uploadFileToMattermost(
                    channelId,
                    buffer,
                    `source-${i + 1}.png`,
                    'image/png'
                );
                fileIds.push(upload.file_infos[0].id);
            } catch (error) {
                botLog.error({message: 'Failed to create website screenshot', url, error});
                omitted.push(`第 ${i + 1} 个 URL ${describeScreenshotError(error)}`);
            }
        }
    } catch (error) {
        botLog.error({message: 'Failed to launch Chromium for screenshots', error});
        omitted.push('无法启动截图浏览器');
    } finally {
        await browser?.close().catch((error: unknown) => botLog.error({message: 'Failed to close screenshot browser', error}));
    }

    return {fileIds, omitted};
}

async function captureWebsiteScreenshot(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string): Promise<Buffer> {
    const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: {
            width: screenshotViewportWidth,
            height: screenshotViewportHeight
        }
    });

    try {
        page.setDefaultTimeout(screenshotTimeoutMs);
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: screenshotTimeoutMs
        });
        await page.waitForLoadState('networkidle', {timeout: Math.min(3000, screenshotTimeoutMs)}).catch(() => undefined);
        return await page.screenshot({
            type: 'png',
            fullPage: false,
            timeout: screenshotTimeoutMs
        });
    } finally {
        await page.close().catch((error: unknown) => botLog.error({message: 'Failed to close screenshot page', error}));
    }
}

function defaultChromiumExecutablePath(): string | undefined {
    if (process.platform === 'linux') {
        return '/usr/bin/chromium-browser';
    }

    return undefined;
}

function describeScreenshotError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (/Timeout|timed out|timeout/i.test(message)) {
        return "加载超时";
    }
    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(message)) {
        return "域名解析失败";
    }
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) {
        return "连接被拒绝";
    }
    if (/ERR_CERT|certificate|SSL|TLS/i.test(message)) {
        return "证书校验失败";
    }
    if (/Target page|browser has been closed|Executable doesn't exist|Failed to launch/i.test(message)) {
        return "浏览器不可用";
    }
    if (/upload|Mattermost|Failed to upload/i.test(message)) {
        return "截图上传失败";
    }

    return "截图失败";
}
