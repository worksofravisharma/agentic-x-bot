(() => {
  const scripts = ["runtime.js", "polyfills.js", "main.js"];

  const getBaseUrl = () => {
    const script =
      document.currentScript ||
      document.querySelector('script[src*="widget-loader"]');
    if (!script || !script.src) return "./";
    return script.src.slice(0, script.src.lastIndexOf("/") + 1);
  };

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.defer = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

  const loadCss = (href) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  };

  const init = async () => {
    const baseUrl = getBaseUrl();
    loadCss(`${baseUrl}styles.css`);
    for (const file of scripts) {
      await loadScript(`${baseUrl}${file}`);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
