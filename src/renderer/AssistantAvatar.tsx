import { useEffect, useRef } from "react";

export type AssistantExpression = "idle" | "typing" | "thinking" | "success";

export function StaticAssistantAvatar({
  className = "",
  size = 28,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={`ai-static-avatar ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 56"
      role="img"
      aria-label="Scout"
    >
      <path
        d="M13 7.5C7.5 10.8 5 17.1 5 27.7c0 10.9 2.7 17.2 8.7 20.4 4.7 2.6 31.9 2.6 36.6 0 6-3.2 8.7-9.5 8.7-20.4 0-10.6-2.5-16.9-8-20.2C46.2 4.6 17.8 4.6 13 7.5Z"
        fill="#252937"
        stroke="rgba(255,255,255,.14)"
      />
      <ellipse cx="21" cy="28" rx="8" ry="11" fill="#f7fbff" />
      <ellipse cx="43" cy="28" rx="8" ry="11" fill="#f7fbff" />
      <ellipse cx="21" cy="28" rx="5.5" ry="7.5" fill="#68ded6" opacity=".24" />
      <ellipse cx="21" cy="28" rx="3.5" ry="5.5" fill="#68ded6" />
      <ellipse cx="43" cy="28" rx="5.5" ry="7.5" fill="#68ded6" opacity=".24" />
      <ellipse cx="43" cy="28" rx="3.5" ry="5.5" fill="#68ded6" />
    </svg>
  );
}

export function AnimatedAssistantAvatar({
  state,
  variant = "hero",
  className = "",
}: {
  state: AssistantExpression;
  variant?: "hero" | "inline";
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || state === "thinking") return;
    const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
    const reducedMotion = () =>
      document.documentElement.dataset.scoutReducedMotion === "true" ||
      motionPreference.matches;
    const render = () => {
      frame.current = null;
      current.current.x += (target.current.x - current.current.x) * 0.16;
      current.current.y += (target.current.y - current.current.y) * 0.16;
      element.style.setProperty(
        "--ai-eye-x",
        `${current.current.x.toFixed(2)}px`,
      );
      element.style.setProperty(
        "--ai-eye-y",
        `${current.current.y.toFixed(2)}px`,
      );
      if (
        Math.abs(target.current.x - current.current.x) > 0.05 ||
        Math.abs(target.current.y - current.current.y) > 0.05
      ) {
        frame.current = requestAnimationFrame(render);
      }
    };
    const reset = (immediate = false) => {
      target.current = { x: 0, y: 0 };
      if (immediate) {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        current.current = { x: 0, y: 0 };
        element.style.setProperty("--ai-eye-x", "0px");
        element.style.setProperty("--ai-eye-y", "0px");
        return;
      }
      if (frame.current === null) frame.current = requestAnimationFrame(render);
    };
    const move = (event: globalThis.PointerEvent) => {
      if (reducedMotion()) {
        reset(true);
        return;
      }
      const bounds = element.getBoundingClientRect();
      target.current = {
        x: Math.max(
          -3,
          Math.min(3, (event.clientX - bounds.left - bounds.width / 2) / 16),
        ),
        y: Math.max(
          -2,
          Math.min(2, (event.clientY - bounds.top - bounds.height / 2) / 20),
        ),
      };
      if (frame.current === null) frame.current = requestAnimationFrame(render);
    };
    const syncMotionPreference = () => {
      if (reducedMotion()) reset(true);
    };
    const handleBlur = () => reset(reducedMotion());
    const observer = new MutationObserver(syncMotionPreference);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-scout-reduced-motion"],
    });
    addEventListener("pointermove", move, { passive: true });
    addEventListener("blur", handleBlur);
    motionPreference.addEventListener("change", syncMotionPreference);
    syncMotionPreference();
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("blur", handleBlur);
      motionPreference.removeEventListener("change", syncMotionPreference);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      element.style.setProperty("--ai-eye-x", "0px");
      element.style.setProperty("--ai-eye-y", "0px");
    };
  }, [state]);

  return (
    <div
      className={`ai-character-stage ai-character-stage-${state} ai-character-stage-${variant} ${className}`.trim()}
      aria-hidden="true"
    >
      {state === "thinking" && (
        <>
          <span className="ai-thinking-bulb material-icon material-symbols-rounded">
            lightbulb
          </span>
          <span className="ai-thinking-page-orbit">
            <i className="ai-thinking-page" />
            <i className="ai-thinking-page" />
            <i className="ai-thinking-page" />
          </span>
        </>
      )}
      <div className={`ai-character ai-character-${state}`} ref={root}>
        <span className="ai-character-eye">
          <i />
        </span>
        <span className="ai-character-eye">
          <i />
        </span>
      </div>
    </div>
  );
}
