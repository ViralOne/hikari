import { render } from "@solidjs/web";
import "@fontsource-variable/onest/wght.css";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

render(() => <App />, root);
