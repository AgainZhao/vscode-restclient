import { inspect } from 'util';

import Logger from '../logger';

/**
 * Creates a console implementation for user scripts and writes messages to the REST output channel.
 */
export function createScriptConsole(scriptType: string): Console {
    const write = (level: string, args: unknown[]): void => {
        Logger.script(`${scriptType} ${level}`, args.map(formatConsoleArgument).join(' '));
    };

    return {
        ...console,
        debug: (...args: unknown[]) => write('debug', args),
        error: (...args: unknown[]) => write('error', args),
        info: (...args: unknown[]) => write('info', args),
        log: (...args: unknown[]) => write('log', args),
        warn: (...args: unknown[]) => write('warn', args),
    };
}

/**
 * Formats a console argument into readable text for the output channel.
 */
function formatConsoleArgument(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    return inspect(value, {
        breakLength: 120,
        colors: false,
        depth: 5,
    });
}
