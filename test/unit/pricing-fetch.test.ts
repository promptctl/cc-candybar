import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { PricingService } from "../../src/segments/pricing";

// The one seam is the network: `get` answers with a real Readable that has the
// reads a test pushes, so what decodes them across a read boundary is node's
// own stream and not a copy of it.
let reads: Buffer[] = [];

jest.mock("node:https", () => ({
  get: (_options: unknown, onResponse: (response: Readable) => void) => {
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        const response = Object.assign(new Readable({ read() {} }), {
          statusCode: 200,
          statusMessage: "OK",
        });
        onResponse(response);
        for (const read of reads) response.push(read);
        response.push(null);
      },
      destroy: () => {},
    });
    return request;
  },
}));

const fetchPricing = () => PricingService["fetchPricingData"]();

const entry = (name: string) => ({ name, input: 1, output: 2, cache_read: 3 });

describe("the pricing fetch", () => {
  test("a character that straddles two reads arrives whole", async () => {
    const body = Buffer.from(JSON.stringify({ model: entry("Modèle") }));
    const inside = body.indexOf(0xc3) + 1;
    reads = [body.subarray(0, inside), body.subarray(inside)];

    const pricing = await fetchPricing();

    expect(pricing?.["model"]?.name).toBe("Modèle");
  });

  test("a body past the size limit is refused, counting every character", async () => {
    const body = Buffer.from(
      JSON.stringify({ model: entry("é".repeat(1100 * 1024)) }),
    );
    reads = [body.subarray(0, body.length / 2), body.subarray(body.length / 2)];

    expect(await fetchPricing()).toBeNull();
  });
});
