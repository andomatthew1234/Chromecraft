import { describe, expect, it } from "vitest";

import { isExpectedExtensionCancellation } from "./extension-operation";

describe("isExpectedExtensionCancellation", () => {
  it("recognizes an intentional review cancellation", () => {
    const error = new Error("The extension download was cancelled.");
    error.name = "AbortError";

    expect(isExpectedExtensionCancellation("reviewing", error)).toBe(true);
  });

  it("does not hide install failures or unrelated review errors", () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";

    expect(isExpectedExtensionCancellation("installing", abort)).toBe(false);
    expect(
      isExpectedExtensionCancellation(
        "reviewing",
        new Error("Signature verification failed."),
      ),
    ).toBe(false);
  });
});
