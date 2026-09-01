const CRM_INTERVALO_MS = 30000;
const CRM_LIMITE_CRITICO_RECURSOS = 90;
const IPS_CRM_SEM_PROCESSO = new Set([
    "192.168.96.162",
    "192.168.96.150",
    "192.168.96.67",
    "192.168.96.66",
]);

let servidoresCrm = [];
let alertasAnterioresCrm = new Set();
let somCrm = true;
let audioCrm = null;
let carregandoCrm = false;
let ordenacaoUptimeCrm = null;

const $ = id => document.getElementById(id);
const esc = valor => String(valor ?? "").replace(/[&<>'"]/g, caractere => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[caractere]));

function processoMonitorado(servidor) {
    return !IPS_CRM_SEM_PROCESSO.has(String(servidor?.ip || "").trim());
}

function badge(valor) {
    const status = String(valor || "indisponivel").toLowerCase();
    const classe = status === "online" ? "online" : status === "offline" ? "offline" : "warning";
    const texto = status === "online" ? "ONLINE" : status === "offline" ? "OFFLINE" : "SEM DADOS";
    return `<span class="crm-badge crm-${classe}">${texto}</span>`;
}

function badgeProcesso(servidor) {
    if (!processoMonitorado(servidor)) {
        return '<span class="crm-badge crm-warning" title="Processo dispensado neste servidor">NÃO MONITORADO</span>';
    }
    const instancias = servidor.crm_messok === "online"
        ? ` <small class="crm-muted">${Number(servidor.crm_messok_instancias || 0)} inst.</small>`
        : "";
    return badge(servidor.crm_messok) + instancias;
}

function temNumero(valor) {
    return valor !== null && valor !== undefined && valor !== "" && Number.isFinite(Number(valor));
}

function duracao(segundos) {
    if (!temNumero(segundos)) return "Sem dados";
    let restante = Math.max(0, Math.floor(Number(segundos)));
    const dias = Math.floor(restante / 86400);
    restante %= 86400;
    const horas = Math.floor(restante / 3600);
    restante %= 3600;
    const minutos = Math.floor(restante / 60);
    return `${dias}d ${horas}h ${minutos}m ${restante % 60}s`;
}

function percentualLivreDisco(servidor) {
    if (!temNumero(servidor?.disco_c_percentual)) return null;
    return Math.max(0, Math.min(100, 100 - Number(servidor.disco_c_percentual)));
}

function alertaRecursos(servidor) {
    const discoLivre = percentualLivreDisco(servidor);
    return (temNumero(servidor.cpu_percentual) && Number(servidor.cpu_percentual) >= CRM_LIMITE_CRITICO_RECURSOS)
        || (temNumero(servidor.memoria_percentual) && Number(servidor.memoria_percentual) >= CRM_LIMITE_CRITICO_RECURSOS)
        || (discoLivre !== null && discoLivre < 20);
}

function medidor(valor, detalhe = "") {
    if (!temNumero(valor)) return '<span class="crm-no-data">Aguardando agente</span>';
    const numero = Math.max(0, Math.min(100, Number(valor)));
    const nivel = numero >= CRM_LIMITE_CRITICO_RECURSOS ? "danger" : numero >= 75 ? "warn" : "";
    return `<div class="crm-resource"><div class="crm-resource-top"><strong>${numero.toFixed(1)}%</strong>${detalhe ? `<small>${esc(detalhe)}</small>` : ""}</div><div class="crm-resource-track"><div class="crm-resource-fill ${nivel}" style="width:${numero}%"></div></div></div>`;
}

function medidorDisco(percentualUsado, livreGb) {
    if (!temNumero(percentualUsado) || !temNumero(livreGb)) {
        return '<span class="crm-no-data">Aguardando agente</span>';
    }
    const usado = Math.max(0, Math.min(100, Number(percentualUsado)));
    const livrePercentual = Math.max(0, Math.min(100, 100 - usado));
    const livre = Math.max(0, Number(livreGb));
    const nivel = livrePercentual < 20 ? "danger" : livrePercentual < 30 ? "warn" : "";
    return `<div class="crm-resource crm-disk" title="${livrePercentual.toFixed(1)}% livre (${livre.toFixed(1)} GB) no disco C:">
        <div class="crm-resource-top"><strong>${livrePercentual.toFixed(1)}% livre</strong><small>${livre.toFixed(1)} GB livres</small></div>
        <div class="crm-resource-track"><div class="crm-resource-fill ${nivel}" style="width:${livrePercentual}%"></div></div>
    </div>`;
}

function motivos(servidor) {
    const lista = [];
    if (servidor.rede !== "online") {
        lista.push("Servidor sem resposta na rede");
    } else if (servidor.agente !== "online") {
        lista.push("Agente CRM sem resposta");
    }
    if (processoMonitorado(servidor) && servidor.agente === "online" && servidor.crm_messok !== "online") {
        lista.push("crm_messok.exe está fechado");
    }
    if (temNumero(servidor.cpu_percentual) && Number(servidor.cpu_percentual) >= CRM_LIMITE_CRITICO_RECURSOS) {
        lista.push(`CPU em nível crítico: ${Number(servidor.cpu_percentual).toFixed(1)}%`);
    }
    if (temNumero(servidor.memoria_percentual) && Number(servidor.memoria_percentual) >= CRM_LIMITE_CRITICO_RECURSOS) {
        lista.push(`Memória RAM em nível crítico: ${Number(servidor.memoria_percentual).toFixed(1)}%`);
    }
    const discoLivre = percentualLivreDisco(servidor);
    if (discoLivre !== null && discoLivre < 20) {
        const detalheGb = temNumero(servidor.disco_c_livre_gb)
            ? ` (${Number(servidor.disco_c_livre_gb).toFixed(1)} GB livres)`
            : "";
        lista.push(`Pouco espaço no disco C: ${discoLivre.toFixed(1)}% livre${detalheGb}`);
    }
    return lista;
}

function corresponde(servidor, filtro) {
    if (filtro === "offline") return servidor.rede !== "online";
    if (filtro === "processo_offline") {
        return processoMonitorado(servidor) && servidor.agente === "online" && servidor.crm_messok !== "online";
    }
    if (filtro === "cpu_critica") return temNumero(servidor.cpu_percentual) && Number(servidor.cpu_percentual) >= CRM_LIMITE_CRITICO_RECURSOS;
    if (filtro === "ram_critica") return temNumero(servidor.memoria_percentual) && Number(servidor.memoria_percentual) >= CRM_LIMITE_CRITICO_RECURSOS;
    if (filtro === "disco_critico") {
        const discoLivre = percentualLivreDisco(servidor);
        return discoLivre !== null && discoLivre < 20;
    }
    if (filtro === "recursos") return alertaRecursos(servidor);
    if (filtro === "alertas") return motivos(servidor).length > 0;
    return true;
}

function linha(servidor) {
    const temAlerta = motivos(servidor).length > 0;
    return `<tr class="${temAlerta ? "crm-row-alert" : ""}">
        <td><div class="crm-server"><span class="crm-server-icon"><i class="fa-solid fa-server"></i></span><strong>${esc(servidor.nome)}</strong><small>${esc(servidor.ip)} · ${esc(servidor.hostname || "hostname indisponível")}</small></div></td>
        <td>${badge(servidor.rede)}</td>
        <td>${badge(servidor.agente)}</td>
        <td><div class="crm-uptime"><strong>${duracao(servidor.uptime_segundos)}</strong><small>${esc(servidor.ultimo_reinicio ? `Desde ${servidor.ultimo_reinicio}` : "Reinício indisponível")}</small></div></td>
        <td>${medidor(servidor.cpu_percentual)}</td>
        <td>${medidor(servidor.memoria_percentual)}</td>
        <td>${medidorDisco(servidor.disco_c_percentual, servidor.disco_c_livre_gb)}</td>
        <td>${badgeProcesso(servidor)}</td>
        <td class="crm-muted crm-verified">${esc(servidor.verificado_em || "Sem leitura")}</td>
    </tr>`;
}

function renderizar() {
    const filtro = $("filtro_crm")?.value || "todos";
    const lista = servidoresCrm.filter(servidor => corresponde(servidor, filtro));
    if (ordenacaoUptimeCrm) {
        lista.sort((servidorA, servidorB) => {
            const uptimeA = temNumero(servidorA.uptime_segundos) ? Number(servidorA.uptime_segundos) : null;
            const uptimeB = temNumero(servidorB.uptime_segundos) ? Number(servidorB.uptime_segundos) : null;
            if (uptimeA === null && uptimeB === null) return String(servidorA.nome || "").localeCompare(String(servidorB.nome || ""), "pt-BR");
            if (uptimeA === null) return 1;
            if (uptimeB === null) return -1;
            const diferenca = uptimeA - uptimeB;
            return ordenacaoUptimeCrm === "asc" ? diferenca : -diferenca;
        });
    }
    $("tabela_crm").innerHTML = lista.length
        ? lista.map(linha).join("")
        : '<tr><td colspan="9">Nenhum servidor neste filtro.</td></tr>';
    $("crm_resumo").textContent = `Exibindo ${lista.length} de ${servidoresCrm.length} servidor(es).`;
    document.querySelectorAll(".crm-card-filter").forEach(card => {
        card.classList.toggle("is-active", card.dataset.filtro === filtro);
    });
}

function alternarOrdenacaoUptimeCrm() {
    ordenacaoUptimeCrm = ordenacaoUptimeCrm === "asc" ? "desc" : "asc";
    const cabecalho = $("th_uptime_crm");
    const botao = $("ordenar_uptime_crm");
    const crescente = ordenacaoUptimeCrm === "asc";
    if (cabecalho) cabecalho.setAttribute("aria-sort", crescente ? "ascending" : "descending");
    if (botao) {
        botao.classList.add("is-active");
        botao.title = crescente ? "Ordenado do menor para o maior. Clique para inverter." : "Ordenado do maior para o menor. Clique para inverter.";
        botao.querySelector("i").className = `fa-solid ${crescente ? "fa-arrow-up-short-wide" : "fa-arrow-down-wide-short"}`;
    }
    renderizar();
}

function atualizarResumo() {
    const monitorados = servidoresCrm.filter(processoMonitorado);
    $("crm_online").textContent = servidoresCrm.filter(item => item.rede === "online").length;
    $("crm_offline").textContent = servidoresCrm.filter(item => item.rede !== "online").length;
    $("crm_processo_online").textContent = monitorados.filter(item => item.crm_messok === "online").length;
    $("crm_processo_offline").textContent = monitorados.filter(item => item.agente === "online" && item.crm_messok !== "online").length;
    $("crm_alertas").textContent = servidoresCrm.filter(item => motivos(item).length > 0).length;
    $("crm_cpu_critica").textContent = servidoresCrm.filter(item => corresponde(item, "cpu_critica")).length;
    $("crm_ram_critica").textContent = servidoresCrm.filter(item => corresponde(item, "ram_critica")).length;
    $("crm_disco_critico").textContent = servidoresCrm.filter(item => corresponde(item, "disco_critico")).length;
}

function contextoAudio() {
    if (!audioCrm) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioCrm = new AudioContext();
    }
    return audioCrm;
}

async function tocarSom() {
    if (!somCrm) return;
    const contexto = contextoAudio();
    if (!contexto) return;
    try {
        await contexto.resume();
        const inicio = contexto.currentTime + .05;
        const compressor = contexto.createDynamicsCompressor();
        const master = contexto.createGain();
        compressor.threshold.value = -16;
        compressor.ratio.value = 12;
        master.gain.setValueAtTime(.72, inicio);
        master.connect(compressor);
        compressor.connect(contexto.destination);
        const disparar = atraso => {
            const comeco = inicio + atraso;
            const fim = comeco + .62;
            const grave = contexto.createOscillator();
            const medio = contexto.createOscillator();
            const ganho = contexto.createGain();
            grave.type = "square";
            medio.type = "sawtooth";
            grave.frequency.setValueAtTime(185, comeco);
            medio.frequency.setValueAtTime(555, comeco);
            ganho.gain.setValueAtTime(.001, comeco);
            for (let pulso = 0; pulso < .54; pulso += .16) {
                ganho.gain.setValueAtTime(.001, comeco + pulso);
                ganho.gain.linearRampToValueAtTime(.48, comeco + pulso + .025);
                ganho.gain.linearRampToValueAtTime(.001, Math.min(comeco + pulso + .15, fim));
            }
            grave.connect(ganho); medio.connect(ganho); ganho.connect(master);
            grave.start(comeco); medio.start(comeco); grave.stop(fim); medio.stop(fim);
        };
        [0, .78, 1.56, 2.75, 3.53, 4.31].forEach(disparar);
        setTimeout(() => { try { master.disconnect(); compressor.disconnect(); } catch (erro) {} }, 5200);
    } catch (erro) {
        console.warn("O navegador bloqueou o alerta sonoro do CRM:", erro);
    }
}

function verificarAlertas() {
    const itens = servidoresCrm.map(servidor => ({ servidor, lista: motivos(servidor) })).filter(item => item.lista.length);
    const atuais = new Set();
    itens.forEach(item => item.lista.forEach(motivo => atuais.add(`${item.servidor.ip}:${motivo}`)));
    if ([...atuais].some(chave => !alertasAnterioresCrm.has(chave))) {
        $("crm_alerta_desc").textContent = `${itens.length} servidor(es) precisam de atenção.`;
        $("crm_alerta_lista").innerHTML = itens.map(item => `<li><strong>${esc(item.servidor.nome)} (${esc(item.servidor.ip)})</strong><span>${item.lista.map(esc).join(" • ")}</span></li>`).join("");
        $("crm_overlay").hidden = false;
        tocarSom();
    }
    alertasAnterioresCrm = atuais;
}

async function carregar() {
    if (carregandoCrm) return;
    carregandoCrm = true;
    const botao = $("btn_atualizar_crm");
    botao.disabled = true;
    try {
        const resposta = await fetch(`/api/crm?_=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
        if (resposta.status === 401) { location.href = "/login"; return; }
        if (!resposta.ok) throw new Error(resposta.status);
        const dados = await resposta.json();
        servidoresCrm = Array.isArray(dados.servidores) ? dados.servidores : [];
        $("crm_ultima").textContent = dados.ultima_verificacao || "-";
        atualizarResumo();
        renderizar();
        verificarAlertas();
    } catch (erro) {
        $("crm_resumo").textContent = "Falha ao consultar o monitoramento CRM.";
        console.error(erro);
    } finally {
        carregandoCrm = false;
        botao.disabled = false;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    $("filtro_crm").addEventListener("change", renderizar);
    $("ordenar_uptime_crm").addEventListener("click", alternarOrdenacaoUptimeCrm);
    $("btn_atualizar_crm").addEventListener("click", carregar);
    $("crm_fechar").addEventListener("click", () => $("crm_overlay").hidden = true);
    $("crm_ver_alertas").addEventListener("click", () => { $("filtro_crm").value = "alertas"; $("crm_overlay").hidden = true; renderizar(); });
    $("crm_testar_som").addEventListener("click", tocarSom);
    $("btn_som_crm").addEventListener("click", () => {
        somCrm = !somCrm;
        $("btn_som_crm").setAttribute("aria-pressed", somCrm ? "true" : "false");
        $("btn_som_crm").querySelector("span").textContent = somCrm ? "Som ligado" : "Som desligado";
        $("btn_som_crm").querySelector("i").className = `fa-solid ${somCrm ? "fa-volume-high" : "fa-volume-xmark"}`;
        if (somCrm) tocarSom();
    });
    document.querySelectorAll(".crm-card-filter").forEach(card => card.addEventListener("click", () => {
        $("filtro_crm").value = $("filtro_crm").value === card.dataset.filtro ? "todos" : card.dataset.filtro;
        renderizar();
    }));
    document.addEventListener("pointerdown", () => contextoAudio()?.resume().catch(() => {}), { once: true });
    carregar();
    setInterval(carregar, CRM_INTERVALO_MS);
});
