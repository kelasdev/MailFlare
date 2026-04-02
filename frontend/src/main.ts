import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const app = mount(App, {
  target: document.getElementById("app")!
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        updateViaCache: "none"
      });
      void registration.update();
    } catch (error) {
      console.error("Service worker registration failed", error);
    }
  });
}

export default app;
