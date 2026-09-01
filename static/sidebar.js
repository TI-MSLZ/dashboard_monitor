document.addEventListener("DOMContentLoaded", () => {
    "use strict";
    const currentPath = window.location.pathname.replace(/\/$/, "");
    document.querySelectorAll("a.menu-item[href]").forEach(item => {
        item.classList.remove("active");
        const itemPath = new URL(item.href).pathname.replace(/\/$/, "");
        const cadastroAtivo = itemPath === "/cadastro" && currentPath.startsWith("/cadastro/");
        const analiticoAtivo = itemPath === "/analitico" && currentPath.startsWith("/analitico/");
        if (currentPath === itemPath || cadastroAtivo || analiticoAtivo) item.classList.add("active");
    });
});
