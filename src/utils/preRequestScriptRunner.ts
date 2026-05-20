import * as fs from 'fs-extra';
import { createRequire } from 'module';
import * as path from 'path';
import { Stream } from 'stream';
import * as vm from 'vm';

import { IRestClientSettings } from '../models/configurationSettings';
import { HttpRequest } from '../models/httpRequest';
import { RequestParserFactory } from '../models/requestParserFactory';
import { MimeUtility } from './mimeUtility';
import { getHeader, removeHeader } from './misc';
import { ScriptVariableCache } from './scriptVariableCache';
import { VariableProcessor } from './variableProcessor';

type HeaderPatch = {
    name: string;
    value?: string;
};

type BodyState = {
    dirty: boolean;
    value: unknown;
};

/**
 * Contains variable, header, and body mutations returned from a pre-request script.
 */
export interface PreRequestExecutionResult {
    body?: string;
    variables: Map<string, string>;
    headerPatches: HeaderPatch[];
}

/**
 * Executes user JavaScript before a request is sent and applies its request mutations.
 */
export class PreRequestScriptRunner {
    private static readonly timeoutInMilliseconds = 1000;
    private static readonly allowedModules = new Set(['crypto']);
    private static readonly nodeRequire = createRequire(__filename);

    /**
     * Runs a JavaScript file against a resolved request and returns requested mutations.
     */
    public static async run(
        scriptPath: string,
        requestText: string,
        settings: IRestClientSettings,
        baseVariables: Map<string, string>,
        httpFilePath: string,
    ): Promise<PreRequestExecutionResult> {
        const absoluteScriptPath = await this.resolveScriptPath(scriptPath, httpFilePath);
        const code = await fs.readFile(absoluteScriptPath, 'utf8');

        const parsedRequest = await RequestParserFactory
            .createRequestParser(requestText, settings)
            .parseHttpRequest();

        const variables = new Map<string, string>();
        const headerPatches: HeaderPatch[] = [];
        const bodyState = this.createBodyState(parsedRequest);
        const sandbox = {
            Buffer,
            URL,
            URLSearchParams,
            console,

            require: (moduleName: string) => {
                const normalizedModuleName = moduleName.startsWith('node:')
                    ? moduleName.slice('node:'.length)
                    : moduleName;

                if (
                    !this.allowedModules.has(moduleName) &&
                    !this.allowedModules.has(normalizedModuleName)
                ) {
                    throw new Error(`Module "${moduleName}" is not allowed in pre-request script`);
                }

                return this.nodeRequire(moduleName);
            },

            request: this.createRequestFacade(parsedRequest, headerPatches, bodyState),
            variables: {
                get: (name: string): string | undefined => {
                    return variables.get(name) ?? baseVariables.get(name);
                },

                resolve: async (name: string): Promise<string | undefined> => {
                    const token = `{{${name}}}`;
                    const resolved = await VariableProcessor.processRawRequest(
                        token,
                        new Map([...baseVariables, ...variables]),
                    );

                    return resolved === token ? undefined : resolved;
                },

                set: (name: string, value: unknown): void => {
                    variables.set(name, String(value));
                    ScriptVariableCache.set(name, value);
                },
            },
        };

        const context = vm.createContext(sandbox);
        const script = new vm.Script(
            `(async () => {\n${code}\n})()`,
            { filename: absoluteScriptPath },
        );
        const result = script.runInContext(context, {
            timeout: this.timeoutInMilliseconds,
        });

        await this.withTimeout(Promise.resolve(result), this.timeoutInMilliseconds);

        return {
            body: bodyState.dirty
                ? this.serializeBody(bodyState.value, parsedRequest, headerPatches)
                : undefined,
            headerPatches,
            variables,
        };
    }

    /**
     * Applies header mutations produced by a pre-request script to the parsed request.
     */
    public static applyToRequest(
        request: HttpRequest,
        result: PreRequestExecutionResult,
    ): void {
        if (result.body !== undefined) {
            request.body = result.body;
            request.rawBody = result.body;
        }

        for (const patch of result.headerPatches) {
            if (patch.value === undefined) {
                removeHeader(request.headers, patch.name);
            } else {
                request.headers[patch.name] = patch.value;
            }
        }
    }

    /**
     * Creates the request API exposed inside a pre-request script.
     */
    private static createRequestFacade(
        request: HttpRequest,
        headerPatches: HeaderPatch[],
        bodyState: BodyState,
    ) {
        const facade = {
            headers: {
                delete: (name: string): void => {
                    headerPatches.push({ name });
                },

                get: (name: string): string | undefined => {
                    return getHeader(request.headers, name) as string | undefined;
                },

                set: (name: string, value: unknown): void => {
                    headerPatches.push({ name, value: String(value) });
                },
            },
            method: request.method,
            rawBody: request.rawBody,
            url: request.url,
        };

        Object.defineProperty(facade, 'body', {
            enumerable: true,
            get: () => {
                return bodyState.value;
            },
            set: (value: unknown) => {
                bodyState.value = this.createTrackedBodyValue(value, bodyState);
                bodyState.dirty = true;
            },
        });

        return facade;
    }

    /**
     * Creates mutable body state for script reads and later serialization.
     */
    private static createBodyState(request: HttpRequest): BodyState {
        const state: BodyState = {
            dirty: false,
            value: undefined,
        };
        const body = this.bodyToString(request.body);
        const contentType = getHeader(request.headers, 'Content-Type')?.toString();
        state.value = this.createTrackedBodyValue(this.parseBody(body, contentType), state);
        return state;
    }

    /**
     * Wraps object bodies so direct property assignment marks the request body dirty.
     */
    private static createTrackedBodyValue(value: unknown, state: BodyState): unknown {
        if (!value || typeof value !== 'object') {
            return value;
        }

        return new Proxy(value as Record<string, unknown>, {
            deleteProperty: (target, property): boolean => {
                state.dirty = true;
                return delete target[property as keyof typeof target];
            },

            set: (target, property, propertyValue): boolean => {
                state.dirty = true;
                target[property as keyof typeof target] = propertyValue;
                return true;
            },
        });
    }

    /**
     * Parses a text request body into the most useful JavaScript value for scripts.
     */
    private static parseBody(body: string | undefined, contentType: string | undefined): unknown {
        if (body === undefined) {
            return undefined;
        }

        if (MimeUtility.isJSON(contentType)) {
            try {
                return JSON.parse(body);
            } catch {
                return body;
            }
        }

        if (MimeUtility.isFormUrlEncoded(contentType)) {
            return Object.fromEntries(new URLSearchParams(body));
        }

        return body;
    }

    /**
     * Serializes a script body value back to request text and updates headers when needed.
     */
    private static serializeBody(
        value: unknown,
        request: HttpRequest,
        headerPatches: HeaderPatch[],
    ): string {
        const contentType = getHeader(request.headers, 'Content-Type')?.toString();

        if (typeof value === 'string') {
            return value;
        }

        if (MimeUtility.isFormUrlEncoded(contentType)) {
            return new URLSearchParams(value as Record<string, string>).toString();
        }

        if (!contentType) {
            headerPatches.push({ name: 'Content-Type', value: 'application/json' });
        }

        return JSON.stringify(value);
    }

    /**
     * Converts an in-memory request body into text for script inspection.
     */
    private static bodyToString(body?: string | Stream): string | undefined {
        return typeof body === 'string' ? body : undefined;
    }

    /**
     * Resolves a script path relative to the current HTTP file and verifies it exists.
     */
    private static async resolveScriptPath(scriptPath: string, httpFilePath: string): Promise<string> {
        const httpFileDir = path.dirname(httpFilePath);
        const absolutePath = path.isAbsolute(scriptPath)
            ? scriptPath
            : path.resolve(httpFileDir, scriptPath);
        const normalizedScriptPath = path.normalize(absolutePath);

        if (!await fs.pathExists(normalizedScriptPath)) {
            throw new Error(`Pre-request script not found: ${normalizedScriptPath}`);
        }

        return normalizedScriptPath;
    }

    /**
     * Rejects an asynchronous script when it exceeds the configured execution limit.
     */
    private static async withTimeout<T>(
        promise: Promise<T>,
        timeoutInMilliseconds: number,
    ): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Pre-request script timeout after ${timeoutInMilliseconds}ms`));
            }, timeoutInMilliseconds);
        });

        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}
