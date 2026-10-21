export const EXPRESSIVE_LOADING_SHAPES = [
  "M24 4 L28 15 L38 10 L33 19 L44 24 L33 29 L38 38 L28 33 L24 44 L20 33 L10 38 L15 29 L4 24 L15 19 L10 10 L20 15 Z",
  "M24 5 L31 7 L37 11 L42 17 L43 24 L41 31 L37 37 L31 42 L24 43 L17 41 L11 37 L7 31 L5 24 L7 17 L12 11 L18 7 Z",
  "M24 4 L29 8 L34 12 L39 16 L43 20 L41 27 L39 34 L36 41 L28 42 L20 42 L12 41 L9 34 L7 27 L5 20 L11 14 L18 8 Z",
  "M14 6 L24 5 L34 6 L40 9 L44 15 L45 24 L44 33 L40 39 L34 42 L24 43 L14 42 L8 39 L4 33 L3 24 L4 15 L8 9 Z",
  "M24 3 L29 14 L38 9 L34 19 L45 24 L34 29 L39 39 L29 34 L24 45 L19 34 L9 39 L14 29 L3 24 L14 19 L9 9 L19 14 Z",
  "M24 5 L29 12 L37 8 L36 17 L43 24 L36 30 L39 39 L30 36 L24 43 L18 36 L9 39 L12 30 L5 24 L12 18 L9 9 L18 12 Z",
  "M24 10 L32 11 L38 14 L42 18 L44 24 L42 30 L38 34 L32 37 L24 38 L16 37 L10 34 L6 30 L4 24 L6 18 L10 14 L16 11 Z",
] as const;

interface ExpressiveLoadingIndicatorProps {
  compact?: boolean;
  label?: string;
}

/**
 * Material 3 Expressive indeterminate loading indicator.
 *
 * The compact form scales the official 48/38 container-to-active-shape ratio
 * into a browser favicon slot. Omitting a label makes the indicator decorative,
 * which is appropriate when its parent already exposes aria-busy.
 */
export function ExpressiveLoadingIndicator({
  compact = false,
  label,
}: ExpressiveLoadingIndicatorProps) {
  const className = compact
    ? "expressive-loading expressive-loading--compact"
    : "expressive-loading";

  return (
    <span
      className={className}
      role={label ? "status" : undefined}
      aria-live={label ? "polite" : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg
        className="expressive-loading-svg"
        viewBox="0 0 48 48"
        aria-hidden="true"
      >
        <g className="expressive-loading-rotation">
          <path
            d={EXPRESSIVE_LOADING_SHAPES[0]}
            className="expressive-loading-shape"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
          >
            <animate
              attributeName="d"
              dur="4.55s"
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;0.142857;0.285714;0.428571;0.571428;0.714285;0.857142;1"
              keySplines=".2 0 0 1;.2 0 0 1;.2 0 0 1;.2 0 0 1;.2 0 0 1;.2 0 0 1;.2 0 0 1"
              values={[
                ...EXPRESSIVE_LOADING_SHAPES,
                EXPRESSIVE_LOADING_SHAPES[0],
              ].join(";")}
            />
          </path>
        </g>
      </svg>
      <span className="expressive-loading-static" aria-hidden="true" />
      {label && <span className="visually-hidden">{label}</span>}
    </span>
  );
}
