export type EmbeddedChatAppDependencies = Record<string, unknown>;

export interface EmbeddedChatApp {
	fetch(request: Request): Promise<Response>;
}

export declare function createEmbeddedChatApp(dependencies: EmbeddedChatAppDependencies): EmbeddedChatApp;
