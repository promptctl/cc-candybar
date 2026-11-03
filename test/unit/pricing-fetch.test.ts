import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { PricingService } from "../../src/segments/pricing";

// The one seam is the network: `get` answers with a real Readable that has the
// reads a test pushes, so what decodes them across a read boundary is node's
// own stream and not a copy of it.
let mockReads: Buffer[] = [];
const mockDestroy = jest.fn();

jest.mock("node:https", () => ({
  get: (_options: unknown, onResponse: (response: Readable) => void) => {
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        const response = Object.assign(new Readable({ read() {} }), {
          statusCode: 200,
          statusMessage: "OK",
        });
        onResponse(response);
        for (const read of mockReads) response.push(read);
        response.push(null);
      },
      destroy: mockDestroy,
    });
    return request;
  },
}));

const fetchPricing = () => PricingService["fetchPricingData"]();

const entry = (name: string) => ({ name, input: 1, output: 2, cache_read: 3 });

const inTwoReads = (body: Buffer) => [
  body.subarray(0, body.length / 2),
  body.subarray(body.length / 2),
];

beforeEach(() => {
  mockDestroy.mockClear();
});

describe("the pricing fetch", () => {
  test("a character that straddles two reads arrives whole", async () => {
    const body = Buffer.from(JSON.stringify({ model: entry("Modèle") }));
    const inside = body.indexOf(0xc3) + 1;
    mockReads = [body.subarray(0, inside), body.subarray(inside)];

    const pricing = await fetchPricing();

    expect(pricing?.["model"]?.name).toBe("Modèle");
  });

  test("a body past the size limit is refused and its connection aborted", async () => {
    mockReads = inTwoReads(
      Buffer.from(JSON.stringify({ model: entry("é".repeat(1100 * 1024)) })),
    );

    expect(await fetchPricing()).toBeNull();
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("the limit is on bytes: a body under it in characters but over it in bytes is refused", async () => {
    // 600K two-byte characters: about 1.2 MB on the wire, 600K characters.
    mockReads = inTwoReads(
      Buffer.from(JSON.stringify({ model: entry("é".repeat(600 * 1024)) })),
    );

    expect(await fetchPricing()).toBeNull();
    expect(mockDestroy).toHaveBeenCalled();
  });
});
