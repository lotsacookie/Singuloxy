import { ctx } from "../context.mjs";

export class FakeRequest extends Request {
  constructor(input, init) {
    if (typeof input === "string" || (input && typeof input === "object" && !(input instanceof Request) && "href" in input)) {
      try {
        input = new URL(String(input), ctx.location.href).href;
      }
      catch {}
    }
    super(input, init);
  }
}
