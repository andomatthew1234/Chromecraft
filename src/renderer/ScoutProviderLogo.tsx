import geminiApiLogoUrl from "./assets/providers/gemini-api.svg";
import geminiSparkleUrl from "./assets/providers/gemini-sparkle.png";
import ollamaLogoUrl from "./assets/providers/ollama.svg";

export function GeminiLogo() {
  return (
    <img
      className="scout-provider-logo"
      src={geminiSparkleUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function GeminiApiWordmark() {
  return (
    <img
      className="scout-provider-wordmark"
      src={geminiApiLogoUrl}
      alt="Gemini API"
      draggable={false}
    />
  );
}

export function OllamaLogo() {
  return (
    <img
      className="scout-provider-logo scout-ollama-logo"
      src={ollamaLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function WebsiteGroupingLogo() {
  return (
    <span
      className="scout-website-logo material-symbols-rounded"
      aria-hidden="true"
    >
      globe
    </span>
  );
}
