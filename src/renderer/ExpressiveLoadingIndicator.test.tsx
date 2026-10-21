import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EXPRESSIVE_LOADING_SHAPES,
  ExpressiveLoadingIndicator,
} from "./ExpressiveLoadingIndicator";

describe("ExpressiveLoadingIndicator", () => {
  it("keeps all seven Material shapes compatible for a continuous SVG morph", () => {
    const signatures = EXPRESSIVE_LOADING_SHAPES.map((shape) =>
      shape.match(/[MLZ]/g)?.join(""),
    );

    expect(EXPRESSIVE_LOADING_SHAPES).toHaveLength(7);
    expect(new Set(signatures)).toEqual(new Set([signatures[0]]));
  });

  it("renders the compact tab variant as a decorative expressive indicator", () => {
    const markup = renderToStaticMarkup(<ExpressiveLoadingIndicator compact />);

    expect(markup).toContain("expressive-loading--compact");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('dur="4.55s"');
    expect(markup).not.toContain("tab-status");
  });

  it("announces a labelled full-size indicator", () => {
    const markup = renderToStaticMarkup(
      <ExpressiveLoadingIndicator label="Starting Chromecraft" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Starting Chromecraft");
  });
});
