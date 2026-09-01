let lojasSyspdv = [];
let atualizacaoSyspdvEmAndamento = false;
let ordenacaoUptimeSyspdv = null;

const INTERVALO_SYSPDV_MS = 5 * 60 * 1000;
const CHAVES_SERVICOS = ["offline", "mongodb", "scanntech", "syspdvweb", "sqlserver"];
const FILTROS_RECURSOS_SYSPDV = {
    cpu_critica: loja => temNumeroSyspdv(loja.cpu_percent) && Number(loja.cpu_percent) > 90,
    ram_critica: loja => temNumeroSyspdv(loja.ram_percent) && Number(loja.ram_percent) > 90,
    disco_critico: loja => temNumeroSyspdv(loja.disco_c_livre_percent) && Number(loja.disco_c_livre_percent) < 20
};

function temNumeroSyspdv(valor) {
    return valor !== null
        && valor !== undefined
        && typeof valor !== "boolean"
        && !(typeof valor === "string" && valor.trim() === "")
        && Number.isFinite(Number(valor));
}

function formatarUptimeSyspdv(segundos) {
    if (!temNumeroSyspdv(segundos)) return "Sem dados";

    let restante = Math.max(0, Math.floor(Number(segundos)));
    const dias = Math.floor(restante / 86400);
    restante %= 86400;
    const horas = Math.floor(restante / 3600);
    restante %= 3600;
    const minutos = Math.floor(restante / 60);

    return `${dias}d ${String(horas).padStart(2, "0")}h ${String(minutos).padStart(2, "0")}m`;
}

function celulaUptimeSyspdv(loja) {
    if (!temNumeroSyspdv(loja.uptime_segundos)) {
        return '<span class="syspdv-na">Sem dados</span>';
    }

    const uptime = Math.max(0, Math.floor(Number(loja.uptime_segundos)));
    const reinicio = loja.ultimo_reinicio
        ? `Desde ${escaparHtmlSyspdv(loja.ultimo_reinicio)}`
        : "Data do reinício indisponível";

    const referencia = temNumeroSyspdv(loja.uptime_referencia_ms)
        ? Math.floor(Number(loja.uptime_referencia_ms))
        : Date.now();

    return `<div class="syspdv-uptime">
        <strong data-syspdv-uptime="${uptime}" data-syspdv-referencia="${referencia}">${formatarUptimeSyspdv(uptime)}</strong>
        <small>${reinicio}</small>
    </div>`;
}

function atualizarUptimesSyspdv() {
    document.querySelectorAll("[data-syspdv-uptime]").forEach(elemento => {
        const base = Number(elemento.dataset.syspdvUptime);
        if (Number.isFinite(base)) {
            const decorrido = Math.floor((Date.now() - Number(elemento.dataset.syspdvReferencia || Date.now())) / 1000);
            elemento.textContent = formatarUptimeSyspdv(base + Math.max(0, decorrido));
        }
    });
}

function escaparHtmlSyspdv(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setTextoSyspdv(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = valor;
}

function badgeSyspdv(status, tipo = "servico", titulo = "") {
    const textos = {
        loja: { online: "ONLINE", offline: "OFFLINE" },
        servico: {
            online: "ONLINE",
            offline: "OFFLINE",
            indisponivel: "SEM RESPOSTA",
            nao_monitorado: "ATUALIZAR AGENTE"
        }
    };
    const classes = {
        online: "badge-online",
        offline: "badge-offline",
        indisponivel: "badge-warning",
        nao_monitorado: "badge-warning"
    };
    const texto = textos[tipo]?.[status] || "DESCONHECIDO";
    const classe = classes[status] || "badge-warning";
    const atributoTitulo = titulo ? ` title="${escaparHtmlSyspdv(titulo)}"` : "";
    return `<span class="badge syspdv-badge ${classe}"${atributoTitulo}>${texto}</span>`;
}

function classeMetrica(valor, limiteAlerta, limiteCritico, invertida = false) {
    if (valor === null || valor === undefined) return "";
    if (invertida) {
        if (valor <= limiteCritico) return "critical";
        if (valor <= limiteAlerta) return "warning";
    } else {
        if (valor >= limiteCritico) return "critical";
        if (valor >= limiteAlerta) return "warning";
    }
    return "healthy";
}

function metricaPercentual(valor, detalhe, classe) {
    if (valor === null || valor === undefined) return '<span class="syspdv-na">-</span>';
    const percentual = Math.max(0, Math.min(100, Number(valor)));
    return `
        <div class="syspdv-metric ${classe}">
            <div class="syspdv-metric-label">
                <strong>${percentual.toFixed(1)}%</strong>
                <span>${escaparHtmlSyspdv(detalhe || "")}</span>
            </div>
            <div class="syspdv-progress"><span style="width:${percentual}%"></span></div>
        </div>`;
}

function temServicoOffline(loja) {
    return CHAVES_SERVICOS.some(chave => loja.servicos?.[chave]?.status === "offline");
}

function renderizarCartaoAlertaSyspdv(lojas, idQuantidade, idLista, chaveMetrica) {
    setTextoSyspdv(idQuantidade, lojas.length);
    const lista = document.getElementById(idLista);
    if (!lista) return;

    if (!lojas.length) {
        lista.classList.add("is-clear");
        lista.textContent = "Nenhuma loja em alerta";
        return;
    }

    lista.classList.remove("is-clear");
    lista.innerHTML = lojas.map(loja => {
        const percentual = Number(loja[chaveMetrica]).toFixed(1);
        return `<span class="syspdv-alert-store">${escaparHtmlSyspdv(loja.loja)} · ${percentual}%</span>`;
    }).join("");
}

function renderizarAlertasRecursosSyspdv() {
    const cpuCritica = lojasSyspdv.filter(FILTROS_RECURSOS_SYSPDV.cpu_critica);
    const ramCritica = lojasSyspdv.filter(FILTROS_RECURSOS_SYSPDV.ram_critica);
    const discoCritico = lojasSyspdv.filter(FILTROS_RECURSOS_SYSPDV.disco_critico);

    renderizarCartaoAlertaSyspdv(cpuCritica, "syspdv_cpu_critica", "syspdv_cpu_lojas", "cpu_percent");
    renderizarCartaoAlertaSyspdv(ramCritica, "syspdv_ram_critica", "syspdv_ram_lojas", "ram_percent");
    renderizarCartaoAlertaSyspdv(discoCritico, "syspdv_disco_critico", "syspdv_disco_lojas", "disco_c_livre_percent");
}

function correspondeFiltroSyspdv(loja, filtro) {
    if (filtro === "todas") return true;
    if (filtro === "online" || filtro === "offline") return loja.loja_status === filtro;
    if (filtro === "alerta") return temServicoOffline(loja);
    if (filtro === "desatualizado") return loja.loja_status === "online" && !loja.agente_atualizado;
    if (FILTROS_RECURSOS_SYSPDV[filtro]) return FILTROS_RECURSOS_SYSPDV[filtro](loja);
    return true;
}

function atualizarEstadoCartoesFiltroSyspdv(filtro) {
    document.querySelectorAll("[data-syspdv-filter]").forEach(cartao => {
        const ativo = cartao.dataset.syspdvFilter === filtro;
        cartao.classList.toggle("is-active", ativo);
        cartao.setAttribute("aria-pressed", ativo ? "true" : "false");
    });
    document.querySelectorAll("[data-syspdv-resource-filter]").forEach(cartao => {
        const ativo = cartao.dataset.syspdvResourceFilter === filtro;
        cartao.classList.toggle("is-active", ativo);
        cartao.setAttribute("aria-pressed", ativo ? "true" : "false");
    });
}

function alternarFiltroCartaoSyspdv(filtro) {
    const seletor = document.getElementById("filtro_status_syspdv");
    if (!seletor || !Array.from(seletor.options).some(opcao => opcao.value === filtro)) return;
    seletor.value = seletor.value === filtro ? "todas" : filtro;
    renderizarSyspdv();
}

function montarLinhaSyspdv(loja) {
    const ramDetalhe = loja.ram_usada_gb !== null && loja.ram_total_gb !== null
        ? `${Number(loja.ram_usada_gb).toFixed(1)} / ${Number(loja.ram_total_gb).toFixed(1)} GB`
        : "";
    const discoDetalhe = loja.disco_c_livre_gb !== null && loja.disco_c_total_gb !== null
        ? `${Number(loja.disco_c_livre_gb).toFixed(1)} GB de ${Number(loja.disco_c_total_gb).toFixed(1)} GB`
        : "";
    const processoBadge = chave => {
        const servico = loja.servicos?.[chave] || {};
        const titulo = `${servico.executavel || ""}${servico.processo_encontrado ? ` · encontrado: ${servico.processo_encontrado}` : ""}`;
        return badgeSyspdv(servico.status, "servico", titulo);
    };
    const classeLinha = loja.loja_status === "offline" || temServicoOffline(loja) ? "syspdv-row-alert" : "";

    return `
        <tr class="${classeLinha}">
            <td>
                <div class="syspdv-store">
                    <strong>${escaparHtmlSyspdv(loja.loja)}</strong>
                    <span>${escaparHtmlSyspdv(loja.ip)} · ${escaparHtmlSyspdv(loja.hostname || "sem hostname")}</span>
                </div>
            </td>
            <td>${badgeSyspdv(loja.loja_status, "loja")}</td>
            <td class="syspdv-restart">${celulaUptimeSyspdv(loja)}</td>
            <td>${metricaPercentual(loja.cpu_percent, "", classeMetrica(loja.cpu_percent, 75, 90))}</td>
            <td>${metricaPercentual(loja.ram_percent, ramDetalhe, classeMetrica(loja.ram_percent, 80, 92))}</td>
            <td>${metricaPercentual(loja.disco_c_livre_percent, discoDetalhe, classeMetrica(loja.disco_c_livre_percent, 20, 10, true))}</td>
            <td>${processoBadge("offline")}</td>
            <td>${processoBadge("mongodb")}</td>
            <td>${processoBadge("scanntech")}</td>
            <td>${processoBadge("syspdvweb")}</td>
            <td>${processoBadge("sqlserver")}</td>
        </tr>`;
}

function renderizarSyspdv() {
    const filtro = document.getElementById("filtro_status_syspdv")?.value || "todas";
    const lojasFiltradas = lojasSyspdv.filter(loja => correspondeFiltroSyspdv(loja, filtro));
    if (ordenacaoUptimeSyspdv) {
        lojasFiltradas.sort((lojaA, lojaB) => {
            const uptimeA = temNumeroSyspdv(lojaA.uptime_segundos) ? Number(lojaA.uptime_segundos) : null;
            const uptimeB = temNumeroSyspdv(lojaB.uptime_segundos) ? Number(lojaB.uptime_segundos) : null;
            if (uptimeA === null && uptimeB === null) return String(lojaA.loja || "").localeCompare(String(lojaB.loja || ""), "pt-BR");
            if (uptimeA === null) return 1;
            if (uptimeB === null) return -1;
            const diferenca = uptimeA - uptimeB;
            return ordenacaoUptimeSyspdv === "asc" ? diferenca : -diferenca;
        });
    }
    atualizarEstadoCartoesFiltroSyspdv(filtro);
    const tabela = document.getElementById("tabela_syspdv");
    if (tabela) {
        tabela.innerHTML = lojasFiltradas.length
            ? lojasFiltradas.map(montarLinhaSyspdv).join("")
            : '<tr><td colspan="11" class="empty-row">Nenhuma loja encontrada para este filtro.</td></tr>';
    }
    setTextoSyspdv("syspdv_resumo_lista", `Exibindo ${lojasFiltradas.length} de ${lojasSyspdv.length} loja(s).`);
}

function alternarOrdenacaoUptimeSyspdv() {
    ordenacaoUptimeSyspdv = ordenacaoUptimeSyspdv === "asc" ? "desc" : "asc";
    const cabecalho = document.getElementById("th_uptime_syspdv");
    const botao = document.getElementById("ordenar_uptime_syspdv");
    const crescente = ordenacaoUptimeSyspdv === "asc";
    if (cabecalho) cabecalho.setAttribute("aria-sort", crescente ? "ascending" : "descending");
    if (botao) {
        botao.classList.add("is-active");
        botao.title = crescente ? "Ordenado do menor para o maior. Clique para inverter." : "Ordenado do maior para o menor. Clique para inverter.";
        botao.querySelector("i").className = `fa-solid ${crescente ? "fa-arrow-up-short-wide" : "fa-arrow-down-wide-short"}`;
    }
    renderizarSyspdv();
}

function aplicarResumoSyspdv(data) {
    lojasSyspdv = Array.isArray(data.lojas) ? data.lojas : [];
    const referenciaUptime = Date.now();
    lojasSyspdv.forEach(loja => {
        loja.uptime_referencia_ms = referenciaUptime;
    });
    setTextoSyspdv("syspdv_ultima_verificacao", data.ultima_verificacao || "-");
    setTextoSyspdv("syspdv_lojas_online", Number(data.lojas_online || 0));
    setTextoSyspdv("syspdv_lojas_offline", Number(data.lojas_offline || 0));
    setTextoSyspdv("syspdv_servicos_online", Number(data.servicos_online || 0));
    setTextoSyspdv("syspdv_servicos_offline", Number(data.servicos_offline || 0));
    setTextoSyspdv("syspdv_agentes_atualizados", `${Number(data.agentes_atualizados || 0)}/${Number(data.total_lojas || 0)}`);
    renderizarAlertasRecursosSyspdv();
    renderizarSyspdv();
}

async function carregarSyspdv(forcarAtualizacao = false) {
    if (atualizacaoSyspdvEmAndamento) return;
    atualizacaoSyspdvEmAndamento = true;
    const botao = document.getElementById("btn_atualizar_syspdv");
    if (botao) {
        botao.disabled = true;
        botao.classList.add("atualizando");
    }

    try {
        const parametros = forcarAtualizacao
            ? `?forcar=1&_=${Date.now()}`
            : "";
        const response = await fetch(`/api/servicos-syspdv${parametros}`, {
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
        aplicarResumoSyspdv(await response.json());
    } catch (error) {
        console.error("Falha ao carregar o monitoramento SysPDV:", error);
        setTextoSyspdv("syspdv_ultima_verificacao", "Erro");
        setTextoSyspdv("syspdv_resumo_lista", "Não foi possível consultar os agentes das lojas.");
        const tabela = document.getElementById("tabela_syspdv");
        if (tabela) tabela.innerHTML = '<tr><td colspan="11" class="empty-row">Erro ao carregar o monitoramento.</td></tr>';
    } finally {
        atualizacaoSyspdvEmAndamento = false;
        if (botao) {
            botao.disabled = false;
            botao.classList.remove("atualizando");
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("filtro_status_syspdv")?.addEventListener("change", renderizarSyspdv);
    document.getElementById("ordenar_uptime_syspdv")?.addEventListener("click", alternarOrdenacaoUptimeSyspdv);
    document.querySelectorAll("[data-syspdv-filter], [data-syspdv-resource-filter]").forEach(cartao => {
        const filtro = cartao.dataset.syspdvFilter || cartao.dataset.syspdvResourceFilter;
        const aplicarFiltro = () => alternarFiltroCartaoSyspdv(filtro);
        cartao.addEventListener("click", aplicarFiltro);
        cartao.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                aplicarFiltro();
            }
        });
    });
    document.getElementById("btn_atualizar_syspdv")?.addEventListener("click", () => carregarSyspdv(true));
    carregarSyspdv();
    setInterval(carregarSyspdv, INTERVALO_SYSPDV_MS);
    setInterval(atualizarUptimesSyspdv, 60000);
});
