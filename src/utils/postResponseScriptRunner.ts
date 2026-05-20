import * as fs from 'fs-extra';
import { createRequire } from 'module';
import * as path from 'path';
import * as vm from 'vm';

import { HttpRequest } from '../models/httpRequest';
import { HttpResponse } from '../models/httpResponse';
import { getHeader } from './misc';
import { ScriptVariableCache } from './scriptVariableCache';
import { VariableProcessor } from './variableProcessor';

/**
 * Executes user JavaScript after a response is received.
 */
export class PostResponseScriptRunner {
    private static readonly timeoutInMilliseconds = 1000;
    private static readonly allowedModules = new Set(['crypto']);
    private static readonly nodeRequire = createRequire(__filename);

    /**
     * Runs a JavaScript file with request, response, and variable APIs.
     */
    public static async run(
        scriptPath: string,
        request: HttpRequest,
        response: HttpResponse,
        httpFilePath: string,
    ): Promise<void> {
        const absoluteScriptPath = await this.resolveScriptPath(scriptPath, httpFilePath);
        const code = await fs.readFile(absoluteScriptPath, 'utf8');
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
                    throw new Error(`Module "${moduleName}" is not allowed in post-response script`);
                }

                return this.nodeRequire(moduleName);
            },

            request: this.createRequestFacade(request),
            response: this.createResponseFacade(response),
            variables: {
                get: (name: string): string | undefined => {
                    return ScriptVariableCache.get(name);
                },

                resolve: async (name: string): Promise<string | undefined> => {
                    const token = `{{${name}}}`;
                    const resolved = await VariableProcessor.processRawRequest(token);
                    return resolved === token ? undefined : resolved;
                },

                set: (name: string, value: unknown): void => {
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
    }

    /**
     * Creates a read-only request API exposed inside a post-response script.
     */
    private static createRequestFacade(request: HttpRequest) {
        return {
            body: typeof request.body === 'string' ? request.body : request.rawBody,
            headers: {
                get: (name: string): string | undefined => {
                    return getHeader(request.headers, name)?.toString();
                },
            },
            method: request.method,
            rawBody: request.rawBody,
            url: request.url,
        };
    }

    /**
     * Creates the response API exposed inside a post-response script.
     */
    private static createResponseFacade(response: HttpResponse) {
        return {
            body: response.body,
            bodyBuffer: response.bodyBuffer,
            headers: {
                get: (name: string): string | undefined => {
                    return getHeader(response.headers, name)?.toString();
                },
            },
            httpVersion: response.httpVersion,
            json: (): unknown => {
                return JSON.parse(response.body);
            },
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
        };
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
            throw new Error(`Post-response script not found: ${normalizedScriptPath}`);
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
                reject(new Error(`Post-response script timeout after ${timeoutInMilliseconds}ms`));
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
