let lojasIfood = [];
let atualizacaoIfoodEmAndamento = false;

const INTERVALO_IFOOD_MS = 10 * 60 * 1000;

function escaparHtmlIfood(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setTextoIfood(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = valor;
}

function badgeIfood(status, tipo) {
    const textos = {
        agente: { online: "ONLINE", offline: "OFFLINE" },
        servico: {
            online: "ONLINE",
            offline: "OFFLINE",
            indisponivel: "SEM RESPOSTA",
            nao_monitorado: "ATUALIZAR AGENTE",
            sem_ecommerce: "LOJA SEM E-COMMERCE"
        }
    };
    const classes = {
        online: "badge-online",
        offline: "badge-offline",
        indisponivel: "badge-warning",
        nao_monitorado: "badge-warning",
        sem_ecommerce: "badge-warning"
    };
    const texto = textos[tipo]?.[status] || "DESCONHECIDO";
    const classe = classes[status] || "badge-warning";
    return `<span class="badge ${classe}">${texto}</span>`;
}

function correspondeFiltroIfood(loja, filtro) {
    if (filtro === "todos") return true;
    if (filtro === "monitorado") return loja.monitorado === true;
    if (filtro === "agente_offline") return loja.agente === "offline";
    return loja.status === filtro;
}

function montarLinhasIfood(lojas) {
    if (!lojas.length) {
        return `<tr><td colspan="6" class="empty-row">Nenhuma loja encontrada para este filtro.</td></tr>`;
    }

    return lojas.map(loja => `
        <tr>
            <td>${escaparHtmlIfood(loja.loja)}</td>
            <td class="catracas-ip">${escaparHtmlIfood(loja.ip)}</td>
            <td>${escaparHtmlIfood(loja.hostname || "-")}</td>
            <td>${badgeIfood(loja.agente, "agente")}</td>
            <td>${badgeIfood(loja.status, "servico")}</td>
            <td>${escaparHtmlIfood(loja.processo || "-")}</td>
        </tr>
    `).join("");
}

function renderizarIfood() {
    const filtro = document.getElementById("filtro_status_ifood")?.value || "todos";
    const lojasFiltradas = lojasIfood.filter(loja => correspondeFiltroIfood(loja, filtro));
    const tabela = document.getElementById("tabela_ifood");
    if (tabela) tabela.innerHTML = montarLinhasIfood(lojasFiltradas);
    setTextoIfood("ifood_resumo_lista", `Exibindo ${lojasFiltradas.length} de ${lojasIfood.length} loja(s).`);
}

function aplicarResumoIfood(data) {
    lojasIfood = Array.isArray(data.lojas) ? data.lojas : [];
    setTextoIfood("ifood_ultima_verificacao", data.ultima_verificacao || "-");
    setTextoIfood("ifood_monitoradas", Number(data.lojas_monitoradas || 0));
    setTextoIfood("ifood_online", Number(data.servicos_online || 0));
    setTextoIfood("ifood_offline", Number(data.servicos_offline || 0));
    setTextoIfood("ifood_agentes_online", Number(data.agentes_online || 0));
    renderizarIfood();
}

async function carregarIfood() {
    if (atualizacaoIfoodEmAndamento) return;
    atualizacaoIfoodEmAndamento = true;
    const botao = document.getElementById("btn_atualizar_ifood");
    if (botao) {
        botao.disabled = true;
        botao.classList.add("atualizando");
    }

    try {
        const response = await fetch("/api/ifood", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Accept": "application/json" }
        });
        if (response.status === 401 || response.status === 403) {
            window.location.href = "/login";
            return;
        }
        if (!response.ok) throw new Error(`Erro HTTP ${response.status}`);
        aplicarResumoIfood(await response.json());
    } catch (error) {
        console.error("Falha ao carregar o monitoramento iFood:", error);
        setTextoIfood("ifood_ultima_verificacao", "Erro");
        setTextoIfood("ifood_resumo_lista", "Não foi possível consultar os agentes.");
        const tabela = document.getElementById("tabela_ifood");
        if (tabela) {
            tabela.innerHTML = `<tr><td colspan="6" class="empty-row">Erro ao carregar o monitoramento iFood.</td></tr>`;
        }
    } finally {
        atualizacaoIfoodEmAndamento = false;
        if (botao) {
            botao.disabled = false;
            botao.classList.remove("atualizando");
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("filtro_status_ifood")?.addEventListener("change", renderizarIfood);
    document.getElementById("btn_atualizar_ifood")?.addEventListener("click", carregarIfood);
    carregarIfood();
    setInterval(carregarIfood, INTERVALO_IFOOD_MS);
});
