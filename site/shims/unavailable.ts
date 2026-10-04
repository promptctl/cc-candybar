// Node modules the page has no stand-in for. Importing one is fine; calling it
// throws, naming what was reached, so a path the demo did not expect is loud.
const refuse = (name: string) => () => {
  throw new Error(`${name} is not available in the page`);
};
export const connect = refuse("net.connect");
export const createServer = refuse("net.createServer");
export const createConnection = refuse("net.createConnection");
export const get = refuse("https.get");
export const request = refuse("https.request");
export const createInterface = refuse("readline.createInterface");
export const createRequire = refuse("module.createRequire");
export const json = refuse("stream/consumers.json");
export const text = refuse("stream/consumers.text");
export const writeHeapSnapshot = refuse("v8.writeHeapSnapshot");
export const getHeapStatistics = () => ({ used_heap_size: 0, total_heap_size: 0, heap_size_limit: 0 });
export default { connect, createServer, createConnection, get, request, createInterface, createRequire, json, text, writeHeapSnapshot, getHeapStatistics };
