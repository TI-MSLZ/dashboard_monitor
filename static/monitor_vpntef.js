let lojasVpnTef = [];
let atualizacaoVpnTefEmAndamento = false;
let chavesAlertaVpnTef = new Set();
let audioContextVpnTef = null;
let somVpnTefHabilitado = true;

const INTERVALO_VPNTEF_MS = 60 * 1000;

function escaparHtmlVpnTef(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setTextoVpnTef(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = valor;
}

function servicoOnlineVpnTef(loja, chave) {
    return loja.servicos?.[chave]?.status === "online";
}

function statusGeralVpnTef(loja) {
    if (loja.agente_status !== "online") return "sem_resposta";
    return servicoOnlineVpnTef(loja, "openvpnserv") && servicoOnlineVpnTef(loja, "openvpnserv2")
        ? "saudavel"
        : "alerta";
}

function badgeVpnTef(status, instancias = null) {
    const configuracao = {
        saudavel: ["SAUDÁVEL", "vpntef-online"],
        online: [instancias === null ? "ONLINE" : `ONLINE · ${instancias}`, "vpntef-online"],
        alerta: ["ALERTA", "vpntef-warning"],
        offline: ["OFFLINE", "vpntef-offline"],
        indisponivel: ["SEM LEITURA", "vpntef-warning"],
        sem_resposta: ["SEM RESPOSTA", "vpntef-offline"]
    }[status] || ["DESCONHECIDO", "vpntef-warning"];
    return `<span class="vpntef-badge ${configuracao[1]}">${configuracao[0]}</span>`;
}

function correspondeFiltroVpnTef(loja, filtro) {
    if (filtro === "todas") return true;
    if (filtro === "todos_alertas") return statusGeralVpnTef(loja) !== "saudavel";
    if (filtro === "saudavel" || filtro === "alerta" || filtro === "sem_resposta") {
        return statusGeralVpnTef(loja) === filtro;
    }
    if (filtro === "openvpnserv_offline") return loja.agente_status === "online" && !servicoOnlineVpnTef(loja, "openvpnserv");
    if (filtro === "openvpnserv2_offline") return loja.agente_status === "online" && !servicoOnlineVpnTef(loja, "openvpnserv2");
    return true;
}

function linhaVpnTef(loja) {
    const statusGeral = statusGeralVpnTef(loja);
    const servico1 = loja.servicos?.openvpnserv || {};
    const servico2 = loja.servicos?.openvpnserv2 || {};
    const classeLinha = statusGeral === "saudavel" ? "" : "vpntef-row-alert";
    return `
        <tr class="${classeLinha}">
            <td><div class="vpntef-store"><strong>${escaparHtmlVpnTef(loja.loja)}</strong><span>${escaparHtmlVpnTef(loja.ip)}</span></div></td>
            <td>${badgeVpnTef(statusGeral)}</td>
            <td>${badgeVpnTef(loja.agente_status)}</td>
            <td class="vpntef-hostname">${escaparHtmlVpnTef(loja.hostname || "-")}</td>
            <td>${badgeVpnTef(servico1.status, servico1.status === "online" ? Number(servico1.instancias || 0) : null)}</td>
            <td>${badgeVpnTef(servico2.status, servico2.status === "online" ? Number(servico2.instancias || 0) : null)}</td>
            <td class="vpntef-hostname">${escaparHtmlVpnTef(loja.verificado_em || "-")}</td>
        </tr>`;
}

function renderizarVpnTef() {
    const filtro = document.getElementById("filtro_vpntef")?.value || "todas";
    const lojasFiltradas = lojasVpnTef.filter(loja => correspondeFiltroVpnTef(loja, filtro));
    const tabela = document.getElementById("tabela_vpntef");
    if (tabela) {
        tabela.innerHTML = lojasFiltradas.length
            ? lojasFiltradas.map(linhaVpnTef).join("")
            : '<tr><td colspan="7" class="vpntef-empty">Nenhuma loja encontrada para este filtro.</td></tr>';
    }
    setTextoVpnTef("vpntef_resumo_lista", `Exibindo ${lojasFiltradas.length} de ${lojasVpnTef.length} loja(s).`);
    atualizarCardsFiltroVpnTef(filtro);
}

function atualizarCardsFiltroVpnTef(filtro) {
    document.querySelectorAll(".vpntef-filter-card[data-filtro]").forEach(card => {
        const ativo = card.dataset.filtro === filtro;
        card.classList.toggle("is-active", ativo);
        card.setAttribute("aria-pressed", ativo ? "true" : "false");
    });
}

function alternarFiltroCardVpnTef(card) {
    const select = document.getElementById("filtro_vpntef");
    if (!select || !card?.dataset.filtro) return;
    select.value = select.value === card.dataset.filtro ? "todas" : card.dataset.filtro;
    renderizarVpnTef();
    document.querySelector(".vpntef-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function ocorrenciasVpnTef(lojas) {
    return lojas.reduce((ocorrencias, loja) => {
        const motivos = [];
        if (loja.agente_status !== "online") {
            motivos.push("Agente sem resposta");
        } else {
            if (!servicoOnlineVpnTef(loja, "openvpnserv")) motivos.push("openvpnserv.exe parado");
            if (!servicoOnlineVpnTef(loja, "openvpnserv2")) motivos.push("openvpnserv2.exe parado");
        }
        if (motivos.length) ocorrencias.push({ loja, motivos });
        return ocorrencias;
    }, []);
}

function obterAudioContextVpnTef() {
    if (!audioContextVpnTef) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioContextVpnTef = new AudioContext();
    }
    return audioContextVpnTef;
}

async function tocarAlertaVpnTef() {
    if (!somVpnTefHabilitado) return false;
    const contexto = obterAudioContextVpnTef();
    if (!contexto) return false;
    try {
        if (contexto.state === "suspended") await contexto.resume();
        const inicio = contexto.currentTime + .03;
        const ganhoMestre = contexto.createGain();
        ganhoMestre.gain.value = .52;
        ganhoMestre.connect(contexto.destination);

        [0, .56, 1.12, 1.68].forEach((atraso, indice) => {
            const comeco = inicio + atraso;
            const fim = comeco + .48;
            const subindo = indice % 2 === 0;
            const frequenciaInicial = subindo ? 620 : 1080;
            const frequenciaFinal = subindo ? 1080 : 620;
            const ganhoPulso = contexto.createGain();
            const sirene = contexto.createOscillator();
            const reforco = contexto.createOscillator();

            sirene.type = "sawtooth";
            sirene.frequency.setValueAtTime(frequenciaInicial, comeco);
            sirene.frequency.linearRampToValueAtTime(frequenciaFinal, fim);

            reforco.type = "square";
            reforco.frequency.setValueAtTime(frequenciaInicial / 2, comeco);
            reforco.frequency.linearRampToValueAtTime(frequenciaFinal / 2, fim);

            ganhoPulso.gain.setValueAtTime(.0001, comeco);
            ganhoPulso.gain.exponentialRampToValueAtTime(.36, comeco + .025);
            ganhoPulso.gain.setValueAtTime(.36, fim - .07);
            ganhoPulso.gain.exponentialRampToValueAtTime(.0001, fim);

            sirene.connect(ganhoPulso);
            reforco.connect(ganhoPulso);
            ganhoPulso.connect(ganhoMestre);
            sirene.start(comeco);
            reforco.start(comeco);
            sirene.stop(fim);
            reforco.stop(fim);
        });
        return true;
    } catch (erro) {
        console.warn("O navegador bloqueou o alerta sonoro:", erro);
        return false;
    }
}

function atualizarBotaoSomVpnTef() {
    const botao = document.getElementById("btn_som_vpntef");
    if (!botao) return;
    botao.setAttribute("aria-pressed", somVpnTefHabilitado ? "true" : "false");
    botao.querySelector("i")?.classList.toggle("fa-volume-high", somVpnTefHabilitado);
    botao.querySelector("i")?.classList.toggle("fa-volume-xmark", !somVpnTefHabilitado);
    const texto = botao.querySelector("span");
    if (texto) texto.textContent = somVpnTefHabilitado ? "Som ligado" : "Som desligado";
}

function fecharAlertaVpnTef() {
    const overlay = document.getElementById("vpntef_alerta_overlay");
    if (overlay) overlay.hidden = true;
}

function exibirAlertaVpnTef(ocorrencias) {
    const overlay = document.getElementById("vpntef_alerta_overlay");
    const lista = document.getElementById("vpntef_alerta_lista");
    if (!overlay || !lista) return;
    setTextoVpnTef("vpntef_alerta_descricao", `${ocorrencias.length} loja(s) precisam de atenÃ§Ã£o.`);
    lista.innerHTML = ocorrencias.map(item => `
        <li>
            <strong>${escaparHtmlVpnTef(item.loja.loja)} <small>(${escaparHtmlVpnTef(item.loja.ip)})</small></strong>
            <span>${item.motivos.map(escaparHtmlVpnTef).join(" â€¢ ")}</span>
        </li>`).join("");
    overlay.hidden = false;
    document.getElementById("btn_fechar_alerta_vpntef")?.focus();
    tocarAlertaVpnTef();
}

function verificarNovosAlertasVpnTef() {
    const ocorrencias = ocorrenciasVpnTef(lojasVpnTef);
    const novasChaves = new Set();
    ocorrencias.forEach(item => {
        item.motivos.forEach(motivo => novasChaves.add(`${item.loja.ip}:${motivo}`));
    });
    const existeNovaOcorrencia = [...novasChaves].some(chave => !chavesAlertaVpnTef.has(chave));
    if (existeNovaOcorrencia) {
        exibirAlertaVpnTef(ocorrencias);
    }
    chavesAlertaVpnTef = novasChaves;
}

function aplicarResumoVpnTef(data) {
    lojasVpnTef = Array.isArray(data.lojas) ? data.lojas : [];
    setTextoVpnTef("vpntef_ultima_verificacao", data.ultima_verificacao || "-");
    setTextoVpnTef("vpntef_agentes_online", Number(data.agentes_online || 0));
    setTextoVpnTef("vpntef_agentes_offline", Number(data.agentes_offline || 0));
    setTextoVpnTef("vpntef_openvpnserv_online", `${Number(data.openvpnserv_online || 0)}/${Number(data.total_lojas || 0)}`);
    setTextoVpnTef("vpntef_openvpnserv2_online", `${Number(data.openvpnserv2_online || 0)}/${Number(data.total_lojas || 0)}`);
    setTextoVpnTef("vpntef_lojas_alerta", Number(data.lojas_alerta || 0));
    renderizarVpnTef();
    verificarNovosAlertasVpnTef();
}

async function carregarVpnTef() {
    if (atualizacaoVpnTefEmAndamento) return;
    atualizacaoVpnTefEmAndamento = true;
    const botao = document.getElementById("btn_atualizar_vpntef");
    if (botao) {
        botao.disabled = true;
        botao.classList.add("atualizando");
    }

    try {
        const response = await fetch(`/api/vpntef?_=${Date.now()}`, {
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Accept": "application/json" }
        });
        if (response.status === 401 || response.status === 403) {
            window.location.href = "/login";
            return;
        }
        if (!response.ok) throw new Error(`Erro HTTP ${response.status}`);
        aplicarResumoVpnTef(await response.json());
    } catch (erro) {
        console.error("Falha ao carregar VPN TEF:", erro);
        setTextoVpnTef("vpntef_ultima_verificacao", "Erro");
        setTextoVpnTef("vpntef_resumo_lista", "Não foi possível consultar os agentes das lojas.");
        const tabela = document.getElementById("tabela_vpntef");
        if (tabela) tabela.innerHTML = '<tr><td colspan="7" class="vpntef-empty">Erro ao carregar o monitoramento.</td></tr>';
    } finally {
        atualizacaoVpnTefEmAndamento = false;
        if (botao) {
            botao.disabled = false;
            botao.classList.remove("atualizando");
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("filtro_vpntef")?.addEventListener("change", renderizarVpnTef);
    document.getElementById("btn_atualizar_vpntef")?.addEventListener("click", carregarVpnTef);
    document.querySelectorAll(".vpntef-filter-card[data-filtro]").forEach(card => {
        card.addEventListener("click", () => alternarFiltroCardVpnTef(card));
        card.addEventListener("keydown", evento => {
            if (evento.key === "Enter" || evento.key === " ") {
                evento.preventDefault();
                alternarFiltroCardVpnTef(card);
            }
        });
    });
    document.getElementById("btn_fechar_alerta_vpntef")?.addEventListener("click", fecharAlertaVpnTef);
    document.getElementById("vpntef_alerta_overlay")?.addEventListener("click", evento => {
        if (evento.target.id === "vpntef_alerta_overlay") fecharAlertaVpnTef();
    });
    document.getElementById("btn_ver_alertas_vpntef")?.addEventListener("click", () => {
        const select = document.getElementById("filtro_vpntef");
        if (select) select.value = "todos_alertas";
        fecharAlertaVpnTef();
        renderizarVpnTef();
        document.querySelector(".vpntef-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.getElementById("btn_ativar_som_vpntef")?.addEventListener("click", () => {
        somVpnTefHabilitado = true;
        atualizarBotaoSomVpnTef();
        tocarAlertaVpnTef();
    });
    document.getElementById("btn_som_vpntef")?.addEventListener("click", () => {
        somVpnTefHabilitado = !somVpnTefHabilitado;
        atualizarBotaoSomVpnTef();
        if (somVpnTefHabilitado) tocarAlertaVpnTef();
    });
    document.addEventListener("keydown", evento => {
        if (evento.key === "Escape") fecharAlertaVpnTef();
        if (somVpnTefHabilitado) obterAudioContextVpnTef()?.resume().catch(() => {});
    });
    document.addEventListener("pointerdown", () => {
        if (somVpnTefHabilitado) obterAudioContextVpnTef()?.resume().catch(() => {});
    }, { once: true });
    atualizarBotaoSomVpnTef();
    carregarVpnTef();
    setInterval(carregarVpnTef, INTERVALO_VPNTEF_MS);
});
