import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthBoundary } from "./AuthBoundary";
import { ProjectsApp } from "./ProjectsApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Eigen dashboard root is missing.");

createRoot(root).render(
  <StrictMode>
    <AuthBoundary>
      {window.location.pathname === "/local" ? <App /> : <ProjectsApp />}
    </AuthBoundary>
  </StrictMode>,
);
