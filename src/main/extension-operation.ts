import type { ExtensionsSnapshot } from "../shared/browser";

export function isExpectedExtensionCancellation(
  operation: ExtensionsSnapshot["operation"],
  error: unknown,
): boolean {
  return (
    operation === "reviewing" &&
    error instanceof Error &&
    error.name === "AbortError"
  );
}
