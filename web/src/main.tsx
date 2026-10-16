/** Browser entry: mounts the Fleet WebUI into `#root`. */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("fleet app: #root element missing from index.html");
}
createRoot(rootEl).render(createElement(App));
