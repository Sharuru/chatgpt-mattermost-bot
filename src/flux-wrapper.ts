import {openAILog as log} from "./logging";

// Flux API configuration
const fluxApiUrl = process.env['FLUX_API_URL'] ?? 'https://c-z0-api-01.hash070.com/api/v1/ai/draw/flux/pro-ultra-11';
const fluxModel = process.env['FLUX_MODEL'] ?? 'flux-1.1-pro-ultra';

// Supported aspect ratios
const aspectRatios = {
    "21:9": "21:9",
    "16:9": "16:9",
    "3:2": "3:2",
    "4:3": "4:3",
    "5:4": "5:4",
    "1:1": "1:1",
    "4:5": "4:5",
    "3:4": "3:4",
    "2:3": "2:3",
    "9:16": "9:16",
    "9:21": "9:21"
} as const;

type AspectRatio = typeof aspectRatios[keyof typeof aspectRatios];

function extractAspectRatio(prompt: string): { aspectRatio: AspectRatio | undefined, cleanPrompt: string } {
    // Convert prompt to lowercase for case-insensitive matching
    const lowerPrompt = prompt.toLowerCase();
    
    // Try to find aspect ratio in the prompt
    for (const [ratio, value] of Object.entries(aspectRatios)) {
        // Match patterns like "21:9", "21:9 ratio", "aspect ratio 21:9", etc.
        const patterns = [
            ratio,
            `${ratio} ratio`,
            `aspect ratio ${ratio}`,
            `ratio ${ratio}`,
            `aspect ${ratio}`
        ];
        
        for (const pattern of patterns) {
            if (lowerPrompt.includes(pattern.toLowerCase())) {
                // Remove the aspect ratio information from the prompt
                const cleanPrompt = prompt.replace(new RegExp(pattern, 'i'), '').trim();
                return { aspectRatio: value, cleanPrompt };
            }
        }
    }
    
    return { aspectRatio: undefined, cleanPrompt: prompt };
}

log.debug({fluxApiUrl, fluxModel});

export async function createFluxImage(prompt: string): Promise<string | undefined> {
    try {
        // Extract aspect ratio from prompt
        const { aspectRatio, cleanPrompt } = extractAspectRatio(prompt);
        log.debug({ originalPrompt: prompt, cleanPrompt, aspectRatio });

        const params: Record<string, string> = {
            model: fluxModel,
            prompt: cleanPrompt,
            response_format: 'b64_json'
        };

        // Add aspect_ratio parameter if found
        if (aspectRatio) {
            params.aspect_ratio = aspectRatio;
        }

        const response = await fetch(fluxApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(params)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        log.trace({data: { ...data, b64_json: 'OMITTED' }});
        
        if (data.b64_json) {
            return data.b64_json;
        } else {
            throw new Error('No image data received from Flux API');
        }
    } catch (error) {
        log.error('Error creating image with Flux:', error);
        return undefined;
    }
} 