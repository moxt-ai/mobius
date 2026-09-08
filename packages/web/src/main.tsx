import { App } from "@moxt-ai/mobius-web-core";
import { createRoot } from "react-dom/client";

import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

createRoot(rootElement).render(<App />);
