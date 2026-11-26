// The price table's network edge: the remote pricing.json's body, or why
// there is none.

import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { get as httpsGet } from "node:https";

import { failed, ok } from "../../utils/outcome";
import type { FetchPricing } from "./pricing";

// `get` as node's http and https modules both spell it.
export type Get = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 1024 * 1024;

const PRICING_URL = new URL(
  "https://raw.githubusercontent.com/promptctl/cc-candybar/main/pricing.json",
);

// [LAW:effects-at-boundaries] One request per call, on a connection of its
// own (`agent: false`): no pooled keep-alive socket outlives the answer, and
// the signal ends the request and its connection wherever it stands.
export function remotePricing(get: Get, url: URL): FetchPricing {
  return (signal) =>
    new Promise((resolve) => {
      const request = get(
        url,
        {
          agent: false,
          signal,
          timeout: TIMEOUT_MS,
          headers: { "User-Agent": "cc-candybar", "Cache-Control": "no-cache" },
        },
        (response) => {
          // Before anything can end the request: a response cut off mid-body
          // (an abort, the cap, a refused status) errors, and an error no
          // listener takes would end the process.
          response.on("error", (e) => resolve(failed(e.message, "read")));
          if (response.statusCode !== 200) {
            resolve(
              failed(
                `HTTP ${response.statusCode} ${response.statusMessage}`,
                "read",
              ),
            );
            request.destroy();
            return;
          }
          let body = "";
          let bytes = 0;
          // A multi-byte character can straddle two reads; the response's own
          // decoder holds the partial bytes until the rest arrive. The cap is
          // in bytes, so a decoded chunk is measured by its encoded size.
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BYTES) {
              resolve(failed(`the body passed ${MAX_BYTES} bytes`, "read"));
              request.destroy();
              return;
            }
            body += chunk;
          });
          response.on("end", () => resolve(ok(body)));
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error(`no answer in ${TIMEOUT_MS} ms`)),
      );
      request.on("error", (e) => resolve(failed(e.message, "read")));
    });
}

export const fetchPricing: FetchPricing = remotePricing(httpsGet, PRICING_URL);
