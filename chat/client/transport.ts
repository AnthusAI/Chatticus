/** The application owns the exact endpoint and fresh authorization for each request. */
export type ChatHttpTransport = {
  url: string;
  headers: () => Promise<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
};
