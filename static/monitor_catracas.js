let lojasCatracas = [];
let atualizacaoCatracasEmAndamento = false;

const INTERVALO_CATRACAS_MS = 10 * 60 * 1000;

function escaparHtmlCatracas(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setTextoCatracas(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) {
        elemento.textContent = valor;
    }
}

function badgeCatracas(status, tipo) {
    const textos = {
        agente: {
            online: "ONLINE",
            offline: "OFFLINE"
        },
        catraca: {
            online: "ONLINE",
            offline: "OFFLINE",
            indisponivel: "SEM RESPOSTA",
            nao_monitorado: "ATUALIZAR AGENTE",
            sem_catraca: "LOJA SEM CATRACA"
        }
    };
    const classes = {
        online: "badge-online",
        offline: "badge-offline",
        indisponivel: "badge-warning",
        nao_monitorado: "badge-warning",
        sem_catraca: "badge-warning"
    };
    const texto = textos[tipo]?.[status] || "DESCONHECIDO";
    const classe = classes[status] || "badge-warning";

    return `<span class="badge ${classe}">${texto}</span>`;
}

function correspondeFiltroCatraca(loja, filtro, lojaSelecionada) {
    if (lojaSelecionada && loja.loja !== lojaSelecionada) {
        return false;
    }

    if (filtro === "todos") {
        return true;
    }

    if (filtro === "monitorado") {
        return loja.monitorado === true;
    }

    if (filtro === "agente_offline") {
        return loja.agente === "offline";
    }

    return loja.status === filtro;
}

function atualizarFiltroLojasCatracas() {
    const seletor = document.getElementById("filtro_loja_catraca");
    if (!seletor) {
        return;
    }

    const valorAtual = seletor.value;
    const nomes = [...new Set(lojasCatracas.map(loja => loja.loja).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));

    seletor.innerHTML = `
        <option value="">Todas as lojas</option>
        ${nomes.map(nome => `<option value="${escaparHtmlCatracas(nome)}">${escaparHtmlCatracas(nome)}</option>`).join("")}
    `;

    if (nomes.includes(valorAtual)) {
        seletor.value = valorAtual;
    }
}

function montarLinhasCatracas(lojas) {
    if (!lojas.length) {
        return `
            <tr>
                <td colspan="6" class="empty-row">
                    Nenhuma loja encontrada para este filtro.
                </td>
            </tr>
        `;
    }

    return lojas.map(loja => `
        <tr>
            <td>${escaparHtmlCatracas(loja.loja)}</td>
            <td class="catracas-ip">${escaparHtmlCatracas(loja.ip)}</td>
            <td>${escaparHtmlCatracas(loja.hostname || "-")}</td>
            <td>${badgeCatracas(loja.agente, "agente")}</td>
            <td>${badgeCatracas(loja.status, "catraca")}</td>
            <td>${escaparHtmlCatracas(loja.processo || "-")}</td>
        </tr>
    `).join("");
}

function renderizarCatracas() {
    const seletor = document.getElementById("filtro_status_catraca");
    const filtro = seletor?.value || "todos";
    const lojaSelecionada = document.getElementById("filtro_loja_catraca")?.value || "";
    const lojasFiltradas = lojasCatracas.filter(
        loja => correspondeFiltroCatraca(loja, filtro, lojaSelecionada)
    );
    const tabela = document.getElementById("tabela_catracas");

    if (tabela) {
        tabela.innerHTML = montarLinhasCatracas(lojasFiltradas);
    }

    setTextoCatracas(
        "catracas_resumo_lista",
        `Exibindo ${lojasFiltradas.length} de ${lojasCatracas.length} loja(s).`
    );
}

function aplicarResumoCatracas(data) {
    lojasCatracas = Array.isArray(data.lojas) ? data.lojas : [];
    atualizarFiltroLojasCatracas();

    setTextoCatracas("catracas_ultima_verificacao", data.ultima_verificacao || "-");
    setTextoCatracas("catracas_monitoradas", Number(data.catracas_monitoradas || 0));
    setTextoCatracas("catracas_online", Number(data.catracas_online || 0));
    setTextoCatracas("catracas_offline", Number(data.catracas_offline || 0));
    setTextoCatracas("catracas_agentes_online", Number(data.agentes_online || 0));

    renderizarCatracas();
}

async function carregarCatracas() {
    if (atualizacaoCatracasEmAndamento) {
        return;
    }

    atualizacaoCatracasEmAndamento = true;
    const botao = document.getElementById("btn_atualizar_catracas");

    if (botao) {
        botao.disabled = true;
        botao.classList.add("atualizando");
    }

    try {
        const response = await fetch("/api/catracas", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Accept": "application/json" }
        });

        if (response.status === 401 || response.status === 403) {
            window.location.href = "/login";
            return;
        }

        if (!response.ok) {
            throw new Error(`Erro HTTP ${response.status}`);
        }

        aplicarResumoCatracas(await response.json());
    } catch (error) {
        console.error("Falha ao carregar o monitoramento de catracas:", error);
        setTextoCatracas("catracas_ultima_verificacao", "Erro");
        setTextoCatracas("catracas_resumo_lista", "Não foi possível consultar os agentes.");

        const tabela = document.getElementById("tabela_catracas");
        if (tabela) {
            tabela.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-row">
                        Erro ao carregar o monitoramento de catracas.
                    </td>
                </tr>
            `;
        }
    } finally {
        atualizacaoCatracasEmAndamento = false;

        if (botao) {
            botao.disabled = false;
            botao.classList.remove("atualizando");
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("filtro_status_catraca")
        ?.addEventListener("change", renderizarCatracas);
    document.getElementById("filtro_loja_catraca")
        ?.addEventListener("change", renderizarCatracas);
    document.getElementById("btn_atualizar_catracas")
        ?.addEventListener("click", carregarCatracas);

    carregarCatracas();
    setInterval(carregarCatracas, INTERVALO_CATRACAS_MS);
});
