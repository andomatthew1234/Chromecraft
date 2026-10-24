import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "material-symbols/rounded.css";

import { PerformanceCentre } from "./PerformanceCentre";
import "./performance-centre.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Performance Centre root.");

createRoot(root).render(
  <StrictMode>
    <PerformanceCentre />
  </StrictMode>,
);
