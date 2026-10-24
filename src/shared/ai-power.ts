import type {
  AiModelSnapshot,
  AiProviderId,
  AiProviderSnapshot,
  AiToolsSnapshot,
} from "./ai-tools";

export interface ScoutPowerChoice {
  model: string;
  displayName: string;
  category: "Fastest" | "Lightweight" | "Balanced" | "Most capable";
  detail: string | null;
}

const NON_TEXT_MODEL =
  /(?:^|[-_.:])(?:embed|embedding|rerank|whisper|clip|nomic-embed|bge)(?:$|[-_.:])/iu;
const UNSTABLE_GEMINI_MODEL =
  /(?:preview|experimental|exp|live|tts|audio|image|embedding|transcribe|robotics)/iu;

function parsedParameters(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)?)\s*([bm])/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2]?.toLowerCase() === "m" ? amount / 1_000 : amount;
}

function modelWeight(model: AiModelSnapshot): number {
  const parameters = parsedParameters(model.parameterSize);
  if (parameters !== null) return parameters;
  if (model.size !== null) return model.size / 1024 ** 3;
  return Number.POSITIVE_INFINITY;
}

function detailFor(model: AiModelSnapshot): string | null {
  if (model.parameterSize) return model.parameterSize;
  if (model.size !== null) {
    return `${Math.max(0.1, model.size / 1024 ** 3).toFixed(1)} GB`;
  }
  return model.family;
}

function uniqueModels(models: AiModelSnapshot[]): AiModelSnapshot[] {
  return [...new Map(models.map((model) => [model.name, model])).values()];
}

function representativeModels(models: AiModelSnapshot[], count: number) {
  if (models.length <= count) return models;
  const last = models.length - 1;
  const indexes = Array.from({ length: count }, (_, index) =>
    Math.round((index * last) / (count - 1)),
  );
  return indexes.map((index) => models[index]!).filter(Boolean);
}

function includeSelected(
  representatives: AiModelSnapshot[],
  all: AiModelSnapshot[],
  selectedModel: string | null,
  maximum: number,
) {
  const selected = all.find((model) => model.name === selectedModel);
  if (
    !selected ||
    representatives.some((model) => model.name === selected.name)
  ) {
    return representatives;
  }
  const next = [...representatives, selected].sort(
    (left, right) => all.indexOf(left) - all.indexOf(right),
  );
  while (next.length > maximum) {
    const removable = next.findIndex(
      (model, index) =>
        index > 0 && index < next.length - 1 && model.name !== selected.name,
    );
    next.splice(removable >= 0 ? removable : 0, 1);
  }
  return next;
}

function categories(length: number): ScoutPowerChoice["category"][] {
  if (length <= 1) return ["Balanced"];
  if (length === 2) return ["Fastest", "Most capable"];
  if (length === 3) return ["Fastest", "Balanced", "Most capable"];
  return ["Fastest", "Lightweight", "Balanced", "Most capable"];
}

function localChoices(
  models: AiModelSnapshot[],
  selectedModel: string | null,
): ScoutPowerChoice[] {
  const compatible = uniqueModels(
    models.filter((model) => !NON_TEXT_MODEL.test(model.name)),
  ).sort((left, right) => {
    const weight = modelWeight(left) - modelWeight(right);
    return Number.isNaN(weight) || weight === 0
      ? left.name.localeCompare(right.name)
      : weight;
  });
  const representatives = includeSelected(
    representativeModels(compatible, 4),
    compatible,
    selectedModel,
    4,
  );
  const labels = categories(representatives.length);
  return representatives.map((model, index) => ({
    model: model.name,
    displayName: model.displayName ?? model.name,
    category: labels[index] ?? "Balanced",
    detail: detailFor(model),
  }));
}

function geminiVersion(model: AiModelSnapshot): number {
  const values = [...model.name.matchAll(/(\d+(?:\.\d+)?)/gu)].map((match) =>
    Number(match[1]),
  );
  return values.reduce((score, value, index) => score + value / 10 ** index, 0);
}

function newest(models: AiModelSnapshot[]) {
  return [...models].sort((left, right) => {
    const recommended =
      Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
    return recommended || geminiVersion(right) - geminiVersion(left);
  })[0];
}

function geminiChoices(
  models: AiModelSnapshot[],
  selectedModel: string | null,
): ScoutPowerChoice[] {
  const compatible = uniqueModels(
    models.filter(
      (model) =>
        /^gemini-/iu.test(model.name) &&
        !UNSTABLE_GEMINI_MODEL.test(model.name),
    ),
  );
  const selected = [
    newest(compatible.filter((model) => /flash-lite/iu.test(model.name))),
    newest(
      compatible.filter(
        (model) =>
          /flash/iu.test(model.name) && !/flash-lite/iu.test(model.name),
      ),
    ),
    newest(compatible.filter((model) => /pro/iu.test(model.name))),
  ].filter((model): model is AiModelSnapshot => Boolean(model));
  const fallback = [...compatible].sort(
    (left, right) => geminiVersion(right) - geminiVersion(left),
  );
  const ranked = uniqueModels([...selected, ...fallback]);
  const representatives = includeSelected(
    ranked.slice(0, 3),
    ranked,
    selectedModel,
    3,
  );
  const labels = categories(representatives.length);
  return representatives.map((model, index) => ({
    model: model.name,
    displayName: model.displayName ?? model.name,
    category: labels[index] ?? "Balanced",
    detail: /flash-lite/iu.test(model.name)
      ? "Lowest cloud usage"
      : /flash/iu.test(model.name)
        ? "Fast general-purpose model"
        : "Potentially higher cloud usage",
  }));
}

export function scoutPowerChoices(
  provider: AiProviderId,
  models: AiModelSnapshot[],
  selectedModel: string | null = null,
): ScoutPowerChoice[] {
  return provider === "ollama"
    ? localChoices(models, selectedModel)
    : geminiChoices(models, selectedModel);
}

export function activeProviderSnapshot(
  snapshot: AiToolsSnapshot,
  provider: AiProviderId = snapshot.provider,
): AiProviderSnapshot {
  return provider === "ollama" ? snapshot.ollama : snapshot.gemini;
}
