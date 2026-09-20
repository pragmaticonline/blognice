// Production entry: the public Worker plus the comment-room Durable Object.
// Tests import ./index (and ./comment-room-protocol) directly; those modules
// must never import "cloudflare:workers". This entry is the only module that
// pulls in ./comment-room, keeping the node test graph free of runtime-only
// imports. Validate with: npm run deploy:production:check
export { default } from "./index";
export * from "./index";
export { CommentRoom } from "./comment-room";
