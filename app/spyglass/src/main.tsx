import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/**
 * `Buffer`, in a browser.
 *
 * Solana's web3.js is a Node library wearing a browser hat: `Transaction`
 * serialisation, instruction data and account bytes are all `Buffer`, and both
 * the library and our own code reach for it as a global. Vite does not polyfill
 * Node built-ins, so without this line every path that builds a transaction
 * throws `Buffer is not defined` — and it throws at *send* time, not at build
 * time, which is why the encoder and the reads looked healthy while signing was
 * broken.
 *
 * It has to run before anything imports web3.js, so it lives at the very top of
 * the entrypoint rather than next to the code that needs it.
 */
if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
