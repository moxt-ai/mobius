import { createRoot } from "react-dom/client";
import { App } from "./app";

import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

createRoot(rootElement).render(<App />);
