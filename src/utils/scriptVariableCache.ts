/**
 * Stores variables created by pre-request and post-response scripts for later requests.
 */
export class ScriptVariableCache {
    private static readonly variables = new Map<string, string>();

    /**
     * Reads a script variable by name.
     */
    public static get(name: string): string | undefined {
        return this.variables.get(name);
    }

    /**
     * Returns true when a script variable exists.
     */
    public static has(name: string): boolean {
        return this.variables.has(name);
    }

    /**
     * Writes a script variable as a string value.
     */
    public static set(name: string, value: unknown): void {
        this.variables.set(name, String(value));
    }

    /**
     * Returns all script variables currently held in memory.
     */
    public static entries(): Array<[string, string]> {
        return [...this.variables.entries()];
    }
}
