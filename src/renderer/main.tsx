import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "material-symbols/rounded.css";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
