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
                omitted.push(`${i + 1}`);
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
        viewport: {
            width: screenshotViewportWidth,
            height: screenshotViewportHeight
        }
    });

    try {
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
