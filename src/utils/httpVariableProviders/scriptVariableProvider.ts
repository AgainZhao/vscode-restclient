import { VariableType } from "../../models/variableType";
import { ScriptVariableCache } from "../scriptVariableCache";
import { HttpVariable, HttpVariableProvider } from './httpVariableProvider';

/**
 * Resolves variables written by pre-request and post-response scripts.
 */
export class ScriptVariableProvider implements HttpVariableProvider {
    private static _instance: ScriptVariableProvider;

    public readonly type: VariableType = VariableType.Script;

    /**
     * Returns the shared script variable provider instance.
     */
    public static get Instance(): ScriptVariableProvider {
        if (!this._instance) {
            this._instance = new ScriptVariableProvider();
        }

        return this._instance;
    }

    private constructor() {
    }

    /**
     * Returns true when the script variable exists.
     */
    public async has(name: string): Promise<boolean> {
        return ScriptVariableCache.has(name);
    }

    /**
     * Gets a script variable value.
     */
    public async get(name: string): Promise<HttpVariable> {
        return { name, value: ScriptVariableCache.get(name) };
    }

    /**
     * Gets all script variables currently held in memory.
     */
    public async getAll(): Promise<HttpVariable[]> {
        return ScriptVariableCache.entries().map(([name, value]) => ({ name, value }));
    }
}
