import { RequestMetadata } from './requestMetadata';

/**
 * Represents the request text, metadata, and prompted values selected from an editor.
 */
export interface SelectedRequest {
    text: string;

    metadatas: Map<RequestMetadata, string | undefined>;

    /**
     * Variables collected before request execution, e.g. prompt variables.
     */
    variables?: Map<string, string>;
}
