import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AccessGate } from "./components/AccessGate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccessGate><App /></AccessGate>
  </React.StrictMode>,
);
