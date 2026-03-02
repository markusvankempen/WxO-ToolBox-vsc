/**
 * Generate OpenAPI 3.0 spec from a sample API URL.
 * Parses URL to extract base, path, query params; builds minimal spec for WxO tools.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

const API_KEY_PARAM_NAMES = ['key', 'apikey', 'api_key', 'api-key'];

export type OpenApiFromUrlResult = {
    spec: Record<string, unknown>;
    apiKeyParamName?: string;
    toolName: string;
    displayName: string;
};

/** Check if a query param name is typically used for API keys. */
export function isApiKeyParam(name: string): boolean {
    const lower = name.toLowerCase().replace(/-/g, '_');
    return API_KEY_PARAM_NAMES.includes(lower) || API_KEY_PARAM_NAMES.includes(name.toLowerCase());
}

/** Derive a sensible tool name from hostname (e.g. api.weatherapi.com -> weatherapi). */
function toolNameFromHostname(hostname: string): string {
    const parts = hostname.toLowerCase().split('.');
    if (parts.length >= 2) {
        const first = parts[0];
        const second = parts[1];
        if (first === 'api' || first === 'www') {
            return second.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_') || 'api_tool';
        }
        return first.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_') || 'api_tool';
    }
    return hostname.replace(/[^a-zA-Z0-9]/g, '_') || 'api_tool';
}

/** Build docs URL from API URL (e.g. api.weatherapi.com -> https://www.weatherapi.com/). */
function docsUrlFromApiUrl(parsed: URL): string {
    const hostname = parsed.hostname.toLowerCase();
    const parts = hostname.split('.');
    const protocol = 'https:';
    if (parts.length >= 2) {
        const first = parts[0];
        if (first === 'api') {
            const base = parts.slice(1).join('.');
            return `${protocol}//www.${base}/`;
        }
    }
    return `${protocol}//${parsed.host}/`;
}

/** Fetch description from docs page (meta description, title, or intro). */
async function fetchDescriptionFromDocs(url: string): Promise<string | undefined> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'text/html' },
        });
        clearTimeout(timeout);
        if (!res.ok) return undefined;
        const html = await res.text();
        const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
            || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
        if (metaMatch && metaMatch[1]) {
            return metaMatch[1].trim().slice(0, 500);
        }
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            const t = titleMatch[1].trim();
            if (t.length > 10) return t.slice(0, 500);
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/** Generate OpenAPI 3.0.1 spec from a sample API URL (sync, no fetch). */
export function openApiFromUrl(url: string, toolName?: string): OpenApiFromUrlResult {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL.');
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    const pathname = parsed.pathname || '/';
    const searchParams = parsed.searchParams;

    const defaultName = toolNameFromHostname(parsed.hostname);
    const toolId = (toolName ?? defaultName)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'api_tool';
    const displayName = toolId.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(' ');

    const parameters: Array<Record<string, unknown>> = [];
    let apiKeyParamName: string | undefined;

    for (const [name, value] of searchParams.entries()) {
        const isKey = isApiKeyParam(name);
        if (isKey && !apiKeyParamName) {
            apiKeyParamName = name;
        }
        parameters.push({
            name,
            in: 'query',
            required: !!value && !isKey,
            description: isKey ? 'API key (or use connection)' : `Parameter: ${name}`,
            schema: {
                type: 'string',
                ...(value ? { default: value } : {}),
            },
        });
    }

    const operationId = pathname
        .split('/')
        .filter(Boolean)
        .map((s) => s.replace(/[^a-zA-Z0-9]/g, ''))
        .join('_') || 'get';

    const pathSpec: Record<string, unknown> = {
        [pathname]: {
            get: {
                operationId: `get${operationId.charAt(0).toUpperCase() + operationId.slice(1)}`,
                summary: `GET ${pathname}`,
                description: `API endpoint: ${pathname}`,
                parameters,
                responses: {
                    '200': {
                        description: 'Success',
                        content: {
                            'application/json': {
                                schema: { type: 'object', description: 'Response data' },
                            },
                        },
                    },
                },
            },
        },
    };

    const spec: Record<string, unknown> = {
        openapi: '3.0.1',
        info: {
            title: displayName,
            version: '1.0.0',
            description: `API tool generated from ${url}`,
            'x-ibm-skill-name': displayName,
            'x-ibm-skill-id': toolId.replace(/_/g, '-'),
        },
        servers: [{ url: origin }],
        paths: pathSpec,
    };

    if (apiKeyParamName) {
        (spec as Record<string, unknown>).components = {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'query',
                    name: apiKeyParamName,
                },
            },
        };
        (spec as Record<string, unknown>).security = [{ ApiKeyAuth: [] }];
    }

    return {
        spec,
        apiKeyParamName,
        toolName: toolId,
        displayName,
    };
}

/** Generate spec and optionally fetch description from docs page. */
export async function openApiFromUrlAsync(
    url: string,
    toolName?: string,
    options?: { fetchDescription?: boolean },
): Promise<OpenApiFromUrlResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL.');
    }
    const result = openApiFromUrl(url, toolName);
    if (options?.fetchDescription) {
        const docsUrl = docsUrlFromApiUrl(parsed);
        const fetchedDesc = await fetchDescriptionFromDocs(docsUrl);
        if (fetchedDesc) {
            const info = result.spec.info as Record<string, unknown>;
            info.description = fetchedDesc;
        }
    }
    return result;
}
