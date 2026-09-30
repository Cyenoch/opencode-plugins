// OpenCode V2 resolves a local plugin directory from its root index file.
// It does not read package.json "exports", so expose the source entry here.
// The dist/ build is only needed when publishing the npm package.
export { default } from "./src/index.js"
