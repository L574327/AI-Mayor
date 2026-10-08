import { createRoot } from "react-dom/client";
import logo from "@/assets/images/logo.png";
import App from "./App";
import "./i18n";
import { Suspense } from "react";

const container = document.getElementById("root") as HTMLElement;
const root = createRoot(container);

root.render(
  <Suspense
    fallback={
      <div className="w-[100vw] h-[100vh] flex items-center justify-center">
        <img src={logo} alt="logo" className="w-[60px] h-[60px]" />
      </div>
    }
  >
    <App />
  </Suspense>,
);

// The main window shows itself (the chat client in development, the AI Mayor console in the product); the overlay is shown by its own owner.
if (!new URLSearchParams(window.location.search).has("ai-mayor-overlay") && !new URLSearchParams(window.location.search).has("ai-mayor-subtitle")) {
  window.bridge.renderer.show().catch(() => {});
}
