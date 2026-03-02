/**
 * OpenAPI quick-start templates for WxO Create Tool Panel.
 * Adapted from SkillEditorPanel templates.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 25 Feb 2026
 * @license Apache-2.0
 */

export type TemplateId =
    | 'blank'
    | 'weather'
    | 'world-time'
    | 'aviation-weather'
    | 'dad-jokes'
    | 'news-search'
    | 'news-app'
    | 'universities'
    | 'zip-code'
    | 'currency'
    | 'finance-yahoo';

export function getOpenApiTemplate(id: TemplateId): Record<string, unknown> | null {
    switch (id) {
        case 'weather':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Weather Tool',
                    version: '1.0.0',
                    description:
                        'Get current weather for a location. Uses WeatherAPI.com. Optionally assign a connection for the API key at creation.',
                    'x-ibm-skill-name': 'Weather Tool',
                    'x-ibm-skill-id': 'weather-tool-v1',
                },
                components: {
                    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'query', name: 'key' } },
                },
                security: [{ ApiKeyAuth: [] }],
                servers: [{ url: 'https://api.weatherapi.com/v1' }],
                paths: {
                    '/current.json': {
                        get: {
                            operationId: 'getCurrentWeather',
                            summary: 'Get Current Weather',
                            description:
                                'Get current weather for a city or location (e.g. Toronto,On). API key required via connection or key param.',
                            parameters: [
                                {
                                    name: 'q',
                                    in: 'query',
                                    required: true,
                                    description: 'City name or lat,lon (e.g. Toronto,On or 43.65,-79.38)',
                                    schema: { type: 'string', default: 'Toronto,On' },
                                },
                                {
                                    name: 'key',
                                    in: 'query',
                                    required: false,
                                    description: 'API key (or use connection)',
                                    schema: { type: 'string', title: 'key' },
                                },
                            ],
                            responses: {
                                '200': {
                                    description: 'Current weather data',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    location: {
                                                        type: 'object',
                                                        properties: {
                                                            name: { type: 'string' },
                                                            region: { type: 'string' },
                                                            country: { type: 'string' },
                                                        },
                                                    },
                                                    current: {
                                                        type: 'object',
                                                        properties: {
                                                            temp_c: { type: 'number' },
                                                            condition: { type: 'object' },
                                                            wind_kph: { type: 'number' },
                                                            humidity: { type: 'integer' },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'world-time':
            return {
                openapi: '3.0.0',
                info: {
                    title: 'World Time Skill',
                    version: '2.0.0',
                    description: 'Get current time for any timezone.',
                    'x-ibm-skill-name': 'World Time Skill',
                    'x-ibm-skill-id': 'world-time-skill-v2',
                },
                servers: [{ url: 'https://timeapi.io/api' }],
                paths: {
                    '/Time/current/zone': {
                        get: {
                            operationId: 'getCityTime',
                            summary: 'Get Time',
                            description: 'Get current time for a specific timezone (e.g. Europe/Amsterdam).',
                            parameters: [
                                {
                                    name: 'timeZone',
                                    in: 'query',
                                    required: true,
                                    description:
                                        "The IANA time zone identifier (e.g. 'Europe/Amsterdam', 'America/New_York').",
                                    schema: { type: 'string' },
                                },
                            ],
                            responses: {
                                '200': {
                                    description: 'Success',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    dateTime: {
                                                        type: 'string',
                                                        description: 'Current date/time in ISO format.',
                                                    },
                                                    time: {
                                                        type: 'string',
                                                        description: 'Current time in HH:mm format.',
                                                    },
                                                    timeZone: { type: 'string' },
                                                    dayOfWeek: { type: 'string' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'aviation-weather':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Aviation Weather METAR Skill',
                    version: '1.0.0',
                    description: 'Get latest METAR weather report for a given airport ICAO code.',
                    'x-ibm-skill-name': 'Aviation Weather METAR Skill',
                    'x-ibm-skill-id': 'aviation-weather-metar-skill-v1',
                },
                servers: [{ url: 'https://aviationweather.gov/api/data/metar' }],
                paths: {
                    '/': {
                        get: {
                            operationId: 'getMetar',
                            summary: 'Get METAR Weather Report',
                            description:
                                'Retrieve the latest METAR weather report for a specified airport ICAO code.',
                            parameters: [
                                {
                                    name: 'ids',
                                    in: 'query',
                                    required: true,
                                    description: "ICAO airport code (e.g., 'KJFK', 'EHAM').",
                                    schema: { type: 'string' },
                                },
                                {
                                    name: 'format',
                                    in: 'query',
                                    required: false,
                                    description: "Response format (default: 'json').",
                                    schema: { type: 'string', default: 'json' },
                                },
                            ],
                            responses: {
                                '200': {
                                    description: 'Successful METAR weather report response.',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    data: {
                                                        type: 'array',
                                                        items: {
                                                            type: 'object',
                                                            properties: {
                                                                raw_text: { type: 'string' },
                                                                station_id: { type: 'string' },
                                                                temp_c: { type: 'number' },
                                                                wind_speed_kt: { type: 'integer' },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'dad-jokes':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Dad Jokes Skill',
                    version: '1.0.0',
                    description: 'Get a random dad joke. Guaranteed to make you groan.',
                    'x-ibm-skill-name': 'Dad Jokes Skill',
                    'x-ibm-skill-id': 'dad-jokes-skill-v1',
                },
                servers: [{ url: 'https://icanhazdadjoke.com' }],
                paths: {
                    '/': {
                        get: {
                            operationId: 'getRandomJoke',
                            summary: 'Get Random Dad Joke',
                            description: 'Fetch a random dad joke.',
                            parameters: [],
                            responses: {
                                '200': {
                                    description: 'A random dad joke.',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    id: { type: 'string', description: 'Unique joke ID.' },
                                                    joke: { type: 'string', description: 'The dad joke text.' },
                                                    status: { type: 'integer', description: 'HTTP status code.' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'news-search':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'News Search',
                    version: '1.0.0',
                    description:
                        'Search for news articles. Requires at least one of: q, qInTitle, sources, domains. Assign a connection (NewsAPI, etc.) when creating.',
                    'x-ibm-skill-name': 'News Search Skill',
                    'x-ibm-skill-id': 'news-search-skill-v1',
                },
                components: {
                    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'query', name: 'apiKey' } },
                },
                security: [{ ApiKeyAuth: [] }],
                servers: [{ url: 'https://newsapi.org/v2' }],
                paths: {
                    '/everything': {
                        get: {
                            operationId: 'searchNews',
                            summary: 'Search News',
                            description:
                                'Search news articles. Set at least one of q, qInTitle, sources, or domains.',
                            parameters: [
                                { name: 'q', in: 'query', required: false, description: 'Topic to search for', schema: { type: 'string', title: 'Topic' } },
                                { name: 'qInTitle', in: 'query', required: false, description: 'Search in article titles only', schema: { type: 'string', title: 'Title Search' } },
                                { name: 'sources', in: 'query', required: false, description: 'Comma-separated source IDs', schema: { type: 'string', title: 'Sources' } },
                                { name: 'domains', in: 'query', required: false, description: 'Comma-separated domains (e.g. bbc.co.uk)', schema: { type: 'string', title: 'Domains' } },
                                { name: 'pageSize', in: 'query', required: false, description: 'Number of articles to return', schema: { type: 'integer', title: 'Page Size', default: 5 } },
                            ],
                            responses: {
                                '200': {
                                    description: 'News articles',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    articles: { type: 'array', items: { type: 'object' } },
                                                    totalResults: { type: 'integer' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'news-app':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'News App',
                    version: '1.0.0',
                    description:
                        'Get news articles from NewsAPI. Assign a NewsAPI connection for apiKey, or pass it as a parameter.',
                    'x-ibm-skill-name': 'News App Skill',
                    'x-ibm-skill-id': 'news-app-skill-v1',
                },
                components: {
                    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'query', name: 'apiKey' } },
                },
                security: [{ ApiKeyAuth: [] }],
                servers: [{ url: 'https://newsapi.org' }],
                paths: {
                    '/v2/everything': {
                        get: {
                            operationId: 'getNews',
                            summary: 'Get News',
                            description: 'Get news articles. Use connection for apiKey or pass q, apiKey, pageSize.',
                            parameters: [
                                { name: 'q', in: 'query', required: false, description: 'Topic to search for', schema: { type: 'string', title: 'q', default: 'tesla' } },
                                { name: 'apiKey', in: 'query', required: false, description: 'API key (or use connection)', schema: { type: 'string', title: 'apiKey' } },
                                { name: 'pageSize', in: 'query', required: false, description: 'Number of articles to return', schema: { type: 'string', title: 'pageSize', default: '5' } },
                            ],
                            responses: {
                                '200': {
                                    description: 'News articles',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    status: { type: 'string' },
                                                    articles: { type: 'array', items: { type: 'object' } },
                                                    totalResults: { type: 'integer' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'universities':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'University Search',
                    version: '1.0.0',
                    description: 'Search for universities by name or country.',
                    'x-ibm-skill-name': 'University Search Skill',
                    'x-ibm-skill-id': 'uni-search-skill-v1',
                },
                servers: [{ url: 'http://universities.hipolabs.com' }],
                paths: {
                    '/search': {
                        get: {
                            operationId: 'searchUniversities',
                            summary: 'Search Universities',
                            description: 'Search for universities by country and/or name.',
                            parameters: [
                                { name: 'country', in: 'query', required: false, schema: { type: 'string', default: 'United States' }, description: 'Country to search in' },
                                { name: 'name', in: 'query', required: false, schema: { type: 'string', default: 'Stanford' }, description: 'Name of university' },
                            ],
                            responses: {
                                '200': {
                                    description: 'List of universities',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        name: { type: 'string' },
                                                        country: { type: 'string' },
                                                        web_pages: { type: 'array', items: { type: 'string' } },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'zip-code':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Zip Code Info',
                    version: '1.0.0',
                    description: 'Get location information for a US Zip Code.',
                    'x-ibm-skill-name': 'Zip Code Skill',
                    'x-ibm-skill-id': 'zip-code-skill-v1',
                },
                servers: [{ url: 'http://api.zippopotam.us' }],
                paths: {
                    '/us/{zipcode}': {
                        get: {
                            operationId: 'getZipInfo',
                            summary: 'Get Zip Code Info',
                            description: 'Get location information for a US Zip Code.',
                            parameters: [
                                { name: 'zipcode', in: 'path', required: true, schema: { type: 'string', default: '90210' }, description: 'US Zip Code' },
                            ],
                            responses: {
                                '200': {
                                    description: 'Location info for the zip code',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    'post code': { type: 'string' },
                                                    places: {
                                                        type: 'array',
                                                        items: {
                                                            type: 'object',
                                                            properties: {
                                                                'place name': { type: 'string' },
                                                                state: { type: 'string' },
                                                                latitude: { type: 'string' },
                                                                longitude: { type: 'string' },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'currency':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Currency Exchange',
                    version: '1.0.0',
                    description: 'Get current exchange rates.',
                    'x-ibm-skill-name': 'Currency Skill',
                    'x-ibm-skill-id': 'currency-skill-v1',
                },
                servers: [{ url: 'https://api.frankfurter.app' }],
                paths: {
                    '/latest': {
                        get: {
                            operationId: 'getExchangeRates',
                            summary: 'Get Latest Rates',
                            description: 'Get current exchange rates from a base currency to one or more target currencies.',
                            parameters: [
                                { name: 'from', in: 'query', required: false, schema: { type: 'string', default: 'USD' }, description: 'Base currency' },
                                { name: 'to', in: 'query', required: false, schema: { type: 'string', default: 'EUR,GBP' }, description: 'Target currencies (comma separated)' },
                            ],
                            responses: {
                                '200': {
                                    description: 'Exchange rates',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    base: { type: 'string' },
                                                    date: { type: 'string' },
                                                    rates: { type: 'object', additionalProperties: { type: 'number' } },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        case 'finance-yahoo':
            return {
                openapi: '3.0.1',
                info: {
                    title: 'Stock Quote (Yahoo)',
                    version: '1.0.0',
                    description: 'Get market data for a stock symbol from Yahoo Finance.',
                    'x-ibm-skill-name': 'Stock Quote Skill',
                    'x-ibm-skill-id': 'stock-quote-skill-v1',
                },
                servers: [{ url: 'https://query1.finance.yahoo.com' }],
                paths: {
                    '/v8/finance/chart/{symbol}': {
                        get: {
                            operationId: 'getChart',
                            summary: 'Get Chart Data',
                            description: 'Get historical market chart data for a stock symbol.',
                            parameters: [
                                { name: 'symbol', in: 'path', required: true, schema: { type: 'string', default: 'IBM' }, description: 'Stock Symbol (e.g. IBM, AAPL)' },
                                {
                                    name: 'interval',
                                    in: 'query',
                                    required: false,
                                    schema: { type: 'string', enum: ['1m', '5m', '15m', '1d', '1wk', '1mo'], default: '1d' },
                                    description: 'Data interval',
                                },
                                {
                                    name: 'range',
                                    in: 'query',
                                    required: false,
                                    schema: { type: 'string', enum: ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y', 'max'], default: '1mo' },
                                    description: 'Data range',
                                },
                            ],
                            responses: {
                                '200': {
                                    description: 'Chart data',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    chart: {
                                                        type: 'object',
                                                        properties: {
                                                            result: {
                                                                type: 'array',
                                                                items: {
                                                                    type: 'object',
                                                                    properties: {
                                                                        meta: { type: 'object' },
                                                                        timestamp: { type: 'array', items: { type: 'integer' } },
                                                                    },
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

        default:
            return null;
    }
}
