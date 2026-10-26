import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type PopoverPosition = Pick<
  CSSProperties,
  "left" | "top" | "width" | "maxHeight" | "visibility" | "transformOrigin"
>;

export function AssistantPopover({
  anchorRef,
  boundaryRef,
  children,
  className,
  idealWidth,
  label,
  onClose,
  placement = "top",
  role = "dialog",
}: {
  anchorRef: RefObject<HTMLElement | null>;
  boundaryRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className: string;
  idealWidth: number;
  label: string;
  onClose: () => void;
  placement?: "top" | "bottom";
  role?: "dialog" | "menu";
}) {
  const popoverRef = useRef<HTMLElement>(null);
  const [popoverElement, setPopoverElement] = useState<HTMLElement | null>(
    null,
  );
  const [position, setPosition] = useState<PopoverPosition>({
    left: 0,
    top: 0,
    width: idealWidth,
    maxHeight: 0,
    visibility: "hidden",
    transformOrigin: placement === "top" ? "bottom left" : "top left",
  });

  const restoreFocus = useCallback(() => {
    anchorRef.current?.focus();
    requestAnimationFrame(() => anchorRef.current?.focus());
  }, [anchorRef]);

  const close = useCallback(() => {
    onClose();
    restoreFocus();
  }, [onClose, restoreFocus]);

  const setPopoverRef = useCallback((element: HTMLElement | null) => {
    popoverRef.current = element;
    setPopoverElement(element);
  }, []);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const boundary = boundaryRef.current;
    const popover = popoverElement;
    if (!anchor || !boundary || !popover) return;

    const positionPopover = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const boundaryRect = boundary.getBoundingClientRect();
      const inset = 8;
      const gap = 8;
      const boundaryTop = Math.max(inset, boundaryRect.top + inset);
      const boundaryBottom = Math.min(
        window.innerHeight - inset,
        boundaryRect.bottom - inset,
      );
      const width = Math.max(
        0,
        Math.min(idealWidth, boundaryRect.width - inset * 2),
      );
      const availableAbove = Math.max(0, anchorRect.top - gap - boundaryTop);
      const availableBelow = Math.max(
        0,
        boundaryBottom - anchorRect.bottom - gap,
      );
      const openAbove =
        placement === "top"
          ? availableAbove >= Math.min(180, availableBelow) ||
            availableAbove >= availableBelow
          : !(
              availableBelow >= Math.min(180, availableAbove) ||
              availableBelow >= availableAbove
            );
      const maxHeight = openAbove ? availableAbove : availableBelow;
      // Constrain width before measuring: narrow panels can reflow a popover
      // from a short card into a tall one. Measuring at the ideal width causes
      // a one-frame jump outside the collision boundary.
      popover.style.width = `${Math.round(width)}px`;
      popover.style.maxHeight = `${Math.round(maxHeight)}px`;
      const measuredHeight = Math.min(popover.scrollHeight, maxHeight);
      const preferredLeft = anchorRect.left;
      const left = Math.min(
        Math.max(preferredLeft, boundaryRect.left + inset),
        Math.max(boundaryRect.left + inset, boundaryRect.right - inset - width),
      );
      const top = openAbove
        ? Math.max(boundaryTop, anchorRect.top - gap - measuredHeight)
        : Math.min(anchorRect.bottom + gap, boundaryBottom - measuredHeight);
      setPosition({
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(width),
        maxHeight: Math.round(maxHeight),
        visibility: "visible",
        transformOrigin: openAbove ? "bottom left" : "top left",
      });
    };

    positionPopover();
    const frame = requestAnimationFrame(positionPopover);
    const observer = new ResizeObserver(positionPopover);
    observer.observe(boundary);
    observer.observe(popover);
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    window.visualViewport?.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("scroll", positionPopover);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      window.visualViewport?.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("scroll", positionPopover);
    };
  }, [anchorRef, boundaryRef, idealWidth, placement, popoverElement]);

  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverElement?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorRef, close, popoverElement]);

  useLayoutEffect(() => {
    if (!popoverElement || position.visibility !== "visible") return;
    const focusFirstControl = () => {
      if (popoverElement.contains(document.activeElement)) return;
      const selector =
        role === "menu"
          ? '[role="menuitem"], [role="menuitemradio"]'
          : '[autofocus], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      popoverElement.querySelector<HTMLElement>(selector)?.focus();
    };
    focusFirstControl();
    const frame = requestAnimationFrame(focusFirstControl);
    return () => cancelAnimationFrame(frame);
  }, [popoverElement, position.visibility, role]);

  return createPortal(
    <section
      ref={setPopoverRef}
      className={`ai-popover ${className}`}
      role={role}
      aria-label={label}
      style={position}
      onKeyDown={(event) => {
        if (role !== "menu" || !popoverRef.current) return;
        const items = [
          ...popoverRef.current.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
          ),
        ];
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next: number | null = null;
        if (event.key === "ArrowDown") next = (current + 1) % items.length;
        if (event.key === "ArrowUp") {
          next = (current - 1 + items.length) % items.length;
        }
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = items.length - 1;
        if (next === null) return;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      {children}
    </section>,
    document.body,
  );
}
