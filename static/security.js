(() => {
    "use strict";

    const originalFetch = window.fetch.bind(window);
    const csrfToken = () => {
        const item = document.cookie.split("; ").find(value => value.startsWith("XSRF-TOKEN="));
        return item ? decodeURIComponent(item.slice("XSRF-TOKEN=".length)) : "";
    };

    window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
        const method = String(init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
        if (url.origin === window.location.origin && !["GET", "HEAD", "OPTIONS"].includes(method)) {
            const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
            headers.set("X-CSRF-Token", csrfToken());
            init = {...init, headers, credentials: "same-origin"};
        }
        return originalFetch(input, init);
    };
})();
