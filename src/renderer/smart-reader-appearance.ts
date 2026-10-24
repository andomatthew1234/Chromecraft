import {
  defaultSmartReaderAppearance,
  normalizeSmartReaderAppearance,
  type SmartReaderAppearance,
} from "../shared/smart-reader";

const STORAGE_KEY = "chromecraft-smart-reader-appearance-v1";

export function readSmartReaderAppearance(): SmartReaderAppearance {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? normalizeSmartReaderAppearance(JSON.parse(stored))
      : defaultSmartReaderAppearance;
  } catch {
    return defaultSmartReaderAppearance;
  }
}

export function writeSmartReaderAppearance(
  appearance: SmartReaderAppearance,
): SmartReaderAppearance {
  const normalized = normalizeSmartReaderAppearance(appearance);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Reader appearance remains usable for the current session.
  }
  return normalized;
}
