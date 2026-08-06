// Public Chatroom API. Implementations live in focused protocol, hub, client,
// and browser-view modules; this barrel preserves the extension's import surface.
export * from "./chatroom-protocol";
export * from "./chatroom-hub";
export * from "./chatroom-client";
export { browserViewHtml } from "./chatroom-browser";
