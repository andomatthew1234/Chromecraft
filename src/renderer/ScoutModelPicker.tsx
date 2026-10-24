import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { AiModelSnapshot, AiProviderId } from "../shared/ai-tools";
import "./scout-model-picker.css";

export type ScoutModelCategory = "fast" | "balanced" | "advanced";
export type ScoutModelAvailability = "available" | "checking" | "unavailable";

export interface ScoutModelChoice {
  provider: AiProviderId;
  model: AiModelSnapshot;
  availability?: ScoutModelAvailability;
  category?: ScoutModelCategory;
  description?: string | null;
}

export interface ScoutModelSelection {
  provider: AiProviderId;
  model: string;
}

export interface ScoutModelPickerProps {
  choices: ScoutModelChoice[];
  value: ScoutModelSelection | null;
  onSelect: (choice: ScoutModelChoice) => void;
  label?: string;
  helperText?: string;
  provider?: AiProviderId | "all";
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export interface ModelPickerRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface ModelPickerViewport {
  width: number;
  height: number;
}

export interface ModelPickerPosition {
  placement: "above" | "below" | "sheet";
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export type ModelPickerNavigation = 1 | -1 | "first" | "last";

const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 8;
const MIN_MENU_WIDTH = 320;
const MAX_MENU_WIDTH = 440;
const MAX_MENU_HEIGHT = 560;
const MOBILE_BREAKPOINT = 640;
const EXIT_DURATION_MS = 140;

const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function choiceKey(choice: ScoutModelChoice): string {
  return `${choice.provider}:${choice.model.name}`;
}

function displayName(choice: ScoutModelChoice): string {
  return choice.model.displayName?.trim() || choice.model.name;
}

function searchableText(choice: ScoutModelChoice): string {
  return [
    displayName(choice),
    choice.model.name,
    choice.model.family,
    choice.model.parameterSize,
    choice.category,
    choice.provider,
    choice.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function isAvailable(choice: ScoutModelChoice): boolean {
  return (choice.availability ?? "available") === "available";
}

/** Resolves keyboard movement, including wraparound, without coupling it to the DOM. */
export function nextScoutModelChoiceKey(
  choices: ScoutModelChoice[],
  currentKey: string | null,
  direction: ModelPickerNavigation,
): string | null {
  const enabledChoices = choices.filter(isAvailable);
  if (enabledChoices.length === 0) return null;

  const currentIndex = enabledChoices.findIndex(
    (choice) => choiceKey(choice) === currentKey,
  );
  let nextIndex: number;
  if (direction === "first") nextIndex = 0;
  else if (direction === "last") nextIndex = enabledChoices.length - 1;
  else if (currentIndex < 0)
    nextIndex = direction === 1 ? 0 : enabledChoices.length - 1;
  else
    nextIndex =
      (currentIndex + direction + enabledChoices.length) %
      enabledChoices.length;

  return choiceKey(enabledChoices[nextIndex]);
}

/** Pure model filtering/ranking used by every Scout model selection surface. */
export function filterScoutModelChoices(
  choices: ScoutModelChoice[],
  query: string,
  provider: AiProviderId | "all" = "all",
): ScoutModelChoice[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

  return choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => provider === "all" || choice.provider === provider)
    .filter(({ choice }) => {
      const haystack = searchableText(choice);
      return terms.every((term) => haystack.includes(term));
    })
    .sort((left, right) => {
      const availableDifference =
        Number(isAvailable(right.choice)) - Number(isAvailable(left.choice));
      if (availableDifference !== 0) return availableDifference;

      const recommendedDifference =
        Number(Boolean(right.choice.model.recommended)) -
        Number(Boolean(left.choice.model.recommended));
      if (recommendedDifference !== 0) return recommendedDifference;

      return left.index - right.index;
    })
    .map(({ choice }) => choice);
}

/** Calculates a fixed, collision-safe menu position without relying on browser globals. */
export function calculateScoutModelPickerPosition(
  anchor: ModelPickerRect,
  surface: Pick<ModelPickerRect, "width" | "height">,
  viewport: ModelPickerViewport,
): ModelPickerPosition {
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  const availableWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);

  if (viewportWidth <= MOBILE_BREAKPOINT) {
    const width = Math.min(MAX_MENU_WIDTH, availableWidth);
    const maxHeight = Math.max(
      0,
      Math.min(MAX_MENU_HEIGHT, viewportHeight - VIEWPORT_MARGIN * 2),
    );
    const renderedHeight = Math.min(surface.height || maxHeight, maxHeight);
    return {
      placement: "sheet",
      top: Math.max(
        VIEWPORT_MARGIN,
        viewportHeight - VIEWPORT_MARGIN - renderedHeight,
      ),
      left: Math.max(VIEWPORT_MARGIN, (viewportWidth - width) / 2),
      width,
      maxHeight,
    };
  }

  const width = Math.min(
    MAX_MENU_WIDTH,
    availableWidth,
    Math.max(MIN_MENU_WIDTH, anchor.width),
  );
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.left),
    Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width),
  );
  const below = Math.max(
    0,
    viewportHeight - anchor.bottom - POPOVER_GAP - VIEWPORT_MARGIN,
  );
  const above = Math.max(0, anchor.top - POPOVER_GAP - VIEWPORT_MARGIN);
  const desiredHeight = Math.min(
    surface.height || MAX_MENU_HEIGHT,
    MAX_MENU_HEIGHT,
  );
  const placement =
    below >= Math.min(300, desiredHeight) || below >= above ? "below" : "above";
  const availableHeight = placement === "below" ? below : above;
  const maxHeight = Math.max(0, Math.min(MAX_MENU_HEIGHT, availableHeight));
  const renderedHeight = Math.min(desiredHeight, maxHeight);
  const top =
    placement === "below"
      ? Math.min(
          anchor.bottom + POPOVER_GAP,
          viewportHeight - VIEWPORT_MARGIN - renderedHeight,
        )
      : Math.max(VIEWPORT_MARGIN, anchor.top - POPOVER_GAP - renderedHeight);

  return { placement, top, left, width, maxHeight };
}

function modelDetails(choice: ScoutModelChoice): string {
  const details = [
    choice.description,
    choice.model.family,
    choice.model.parameterSize,
  ].filter(Boolean);
  return details.join(" · ") || choice.model.name;
}

function providerLabel(provider: AiProviderId): string {
  return provider === "gemini" ? "Gemini" : "Ollama";
}

function categoryLabel(category: ScoutModelCategory): string {
  return `${category.charAt(0).toLocaleUpperCase()}${category.slice(1)}`;
}

function ModelOption({
  choice,
  active,
  selected,
  optionId,
  onActivate,
  onSelect,
}: {
  choice: ScoutModelChoice;
  active: boolean;
  selected: boolean;
  optionId: string;
  onActivate: () => void;
  onSelect: () => void;
}) {
  const availability = choice.availability ?? "available";
  const disabled = availability !== "available";

  return (
    <button
      id={optionId}
      className="scout-model-picker__option"
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      disabled={disabled}
      data-active={active || undefined}
      data-selected={selected || undefined}
      onMouseMove={onActivate}
      onFocus={onActivate}
      onClick={onSelect}
      tabIndex={-1}
    >
      <span className="scout-model-picker__provider-mark" aria-hidden="true">
        {choice.provider === "gemini" ? "✦" : "O"}
      </span>
      <span className="scout-model-picker__option-copy">
        <span className="scout-model-picker__option-heading">
          <span>{displayName(choice)}</span>
          {choice.model.recommended ? (
            <span className="scout-model-picker__recommendation">
              Recommended
            </span>
          ) : null}
        </span>
        <span className="scout-model-picker__option-detail">
          {modelDetails(choice)}
        </span>
        <span className="scout-model-picker__option-meta">
          {providerLabel(choice.provider)}
          {choice.category ? ` · ${categoryLabel(choice.category)}` : ""}
          {availability === "checking" ? " · Checking availability…" : ""}
          {availability === "unavailable" ? " · Unavailable" : ""}
        </span>
      </span>
      <span
        className="material-symbols-rounded scout-model-picker__check"
        aria-hidden="true"
      >
        {selected ? "check_circle" : "circle"}
      </span>
    </button>
  );
}

function usePresence(open: boolean): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setClosing(false);
      return;
    }
    if (!present) return;

    setClosing(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  return { present, closing };
}

export function ScoutModelPicker({
  choices,
  value,
  onSelect,
  label = "Model",
  helperText,
  provider = "all",
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
}: ScoutModelPickerProps) {
  const generatedId = useId().replace(/:/g, "");
  const surfaceId = `scout-model-picker-${generatedId}`;
  const listboxId = `${surfaceId}-options`;
  const helperId = `${surfaceId}-helper`;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<AiProviderId | "all">(
    provider,
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [position, setPosition] = useState<ModelPickerPosition>({
    placement: "below",
    top: 0,
    left: 0,
    width: MIN_MENU_WIDTH,
    maxHeight: MAX_MENU_HEIGHT,
  });
  const [positioned, setPositioned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? uncontrolledOpen;
  const { present, closing } = usePresence(open);

  useEffect(() => setProviderFilter(provider), [provider]);

  const providers = useMemo(
    () => Array.from(new Set(choices.map((choice) => choice.provider))),
    [choices],
  );
  const effectiveProvider = provider === "all" ? providerFilter : provider;
  const visibleChoices = useMemo(
    () => filterScoutModelChoices(choices, query, effectiveProvider),
    [choices, effectiveProvider, query],
  );
  const enabledChoices = useMemo(
    () => visibleChoices.filter(isAvailable),
    [visibleChoices],
  );

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) setPositioned(false);
      if (!isControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      const animationFrame = window.requestAnimationFrame(() =>
        triggerRef.current?.focus(),
      );
      wasOpenRef.current = open;
      return () => window.cancelAnimationFrame(animationFrame);
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const currentSelection = choices.find(
      (choice) =>
        choice.provider === value?.provider &&
        choice.model.name === value.model,
    );
    const nextActive =
      (currentSelection && isAvailable(currentSelection)
        ? currentSelection
        : enabledChoices[0]) ?? null;
    setActiveKey(nextActive ? choiceKey(nextActive) : null);
    setQuery("");
  }, [open]); // Intentionally initialise only when the surface opens.

  useEffect(() => {
    if (!open) return;
    if (
      activeKey &&
      enabledChoices.some((choice) => choiceKey(choice) === activeKey)
    )
      return;
    setActiveKey(enabledChoices[0] ? choiceKey(enabledChoices[0]) : null);
  }, [activeKey, enabledChoices, open]);

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    const surface = surfaceRef.current?.getBoundingClientRect();
    if (!anchor || !surface) return;
    const viewport = window.visualViewport;
    setPosition(
      calculateScoutModelPickerPosition(anchor, surface, {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      }),
    );
    setPositioned(true);
  }, []);

  useClientLayoutEffect(() => {
    if (!present || !open) return;
    updatePosition();
    const animationFrame = window.requestAnimationFrame(() => {
      updatePosition();
      searchRef.current?.focus();
    });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, present, updatePosition, visibleChoices.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        surfaceRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return;
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);

  const moveActive = (direction: ModelPickerNavigation) => {
    const nextKey = nextScoutModelChoiceKey(
      visibleChoices,
      activeKey,
      direction,
    );
    if (!nextKey) return;
    setActiveKey(nextKey);
    window.requestAnimationFrame(() =>
      document
        .getElementById(
          `${surfaceId}-${nextKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        )
        ?.scrollIntoView({
          block: "nearest",
        }),
    );
  };

  const selectChoice = (choice: ScoutModelChoice) => {
    if (!isAvailable(choice)) return;
    onSelect(choice);
    close();
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveActive(event.key === "Home" ? "first" : "last");
      return;
    }
    if (event.key === "Enter" && activeKey) {
      const activeChoice = enabledChoices.find(
        (choice) => choiceKey(choice) === activeKey,
      );
      if (activeChoice) {
        event.preventDefault();
        selectChoice(activeChoice);
      }
    }
    if (event.key === "Tab") {
      const focusable = Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const selectedChoice = choices.find(
    (choice) =>
      choice.provider === value?.provider && choice.model.name === value.model,
  );
  const triggerText = selectedChoice
    ? displayName(selectedChoice)
    : "Choose a model";
  const style = {
    "--scout-model-picker-top": `${position.top}px`,
    "--scout-model-picker-left": `${position.left}px`,
    "--scout-model-picker-width": `${position.width}px`,
    "--scout-model-picker-max-height": `${position.maxHeight}px`,
  } as CSSProperties;

  const surface = present ? (
    <div
      className="scout-model-picker__portal"
      data-placement={position.placement}
      data-closing={closing || undefined}
    >
      <button
        className="scout-model-picker__backdrop"
        type="button"
        aria-label="Close model picker"
        onClick={close}
      />
      <div
        ref={surfaceRef}
        id={surfaceId}
        className="scout-model-picker__surface"
        style={style}
        role="dialog"
        aria-modal={position.placement === "sheet" ? true : undefined}
        aria-labelledby={`${surfaceId}-title`}
        data-positioned={positioned || undefined}
        data-placement={position.placement}
        onKeyDown={handleKeyDown}
      >
        <div className="scout-model-picker__handle" aria-hidden="true" />
        <div className="scout-model-picker__header">
          <div>
            <h2 id={`${surfaceId}-title`}>Choose a model</h2>
            <p>Recommended, compatible models appear first.</p>
          </div>
          <button
            className="scout-model-picker__close"
            type="button"
            onClick={close}
            aria-label="Close model picker"
          >
            <span className="material-symbols-rounded" aria-hidden="true">
              close
            </span>
          </button>
        </div>

        <label className="scout-model-picker__search">
          <span className="material-symbols-rounded" aria-hidden="true">
            search
          </span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            role="combobox"
            aria-label="Search models"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={
              activeKey
                ? `${surfaceId}-${activeKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`
                : undefined
            }
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear model search"
            >
              <span className="material-symbols-rounded" aria-hidden="true">
                close
              </span>
            </button>
          ) : null}
        </label>

        {provider === "all" && providers.length > 1 ? (
          <div
            className="scout-model-picker__filters"
            role="group"
            aria-label="Filter by provider"
          >
            {(["all", ...providers] as Array<AiProviderId | "all">).map(
              (filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={providerFilter === filter}
                  onClick={() => setProviderFilter(filter)}
                >
                  {filter === "all" ? "All providers" : providerLabel(filter)}
                </button>
              ),
            )}
          </div>
        ) : null}

        <div
          className="scout-model-picker__results"
          id={listboxId}
          role="listbox"
          aria-label="Models"
        >
          {visibleChoices.length > 0 ? (
            visibleChoices.map((choice) => {
              const key = choiceKey(choice);
              const optionId = `${surfaceId}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              return (
                <ModelOption
                  key={key}
                  choice={choice}
                  optionId={optionId}
                  active={activeKey === key}
                  selected={
                    choice.provider === value?.provider &&
                    choice.model.name === value.model
                  }
                  onActivate={() => isAvailable(choice) && setActiveKey(key)}
                  onSelect={() => selectChoice(choice)}
                />
              );
            })
          ) : (
            <div className="scout-model-picker__empty" role="status">
              <span className="material-symbols-rounded" aria-hidden="true">
                search_off
              </span>
              <strong>No matching models</strong>
              <span>Try a different search or provider.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={`scout-model-picker${className ? ` ${className}` : ""}`}>
      <span className="scout-model-picker__field-label">{label}</span>
      <button
        ref={triggerRef}
        className="scout-model-picker__trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? surfaceId : undefined}
        aria-label={`${label}: ${triggerText}`}
        aria-describedby={helperText ? helperId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span
          className={`scout-model-picker__trigger-icon${selectedChoice ? "" : " material-symbols-rounded"}`}
          aria-hidden="true"
        >
          {selectedChoice?.provider === "gemini"
            ? "✦"
            : selectedChoice
              ? "O"
              : "auto_awesome"}
        </span>
        <span className="scout-model-picker__trigger-copy">
          <strong>{triggerText}</strong>
          <span>
            {selectedChoice
              ? `${providerLabel(selectedChoice.provider)}${selectedChoice.category ? ` · ${categoryLabel(selectedChoice.category)}` : ""}`
              : "Select a compatible Scout model"}
          </span>
        </span>
        <span
          className="material-symbols-rounded scout-model-picker__trigger-chevron"
          aria-hidden="true"
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {helperText ? (
        <span id={helperId} className="scout-model-picker__helper">
          {helperText}
        </span>
      ) : null}
      {surface && typeof document !== "undefined"
        ? createPortal(surface, document.body)
        : surface}
    </div>
  );
}
