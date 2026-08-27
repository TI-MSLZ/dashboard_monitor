let caixasAtuais = [];
let mostrandoApenasOffline = false;
let atualizacaoEmAndamento = false;
let filtroObservacao = "";

const INTERVALO_ATUALIZACAO_MS = 10 * 60 * 1000;

function normalizarTexto(valor) {
    return (valor || "")
        .toString()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
}

function escaparHtml(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function badgeStatusCaixa(valor) {
    const texto = normalizarTexto(valor);

    if (texto === "online") {
        return `<span class="badge badge-online">ONLINE</span>`;
    }

    if (texto === "offline") {
        return `<span class="badge badge-offline">OFFLINE</span>`;
    }

    if (texto === "erro") {
        return `<span class="badge badge-warning">ERRO</span>`;
    }

    return `<span class="badge badge-warning">${escaparHtml(texto || "parcial").toUpperCase()}</span>`;
}

function textoCaixa(item) {
    return item.caixa ?? item.nome_caixa ?? item.nome ?? item.identificador ?? "-";
}

function textoLoja(item) {
    return item.loja ?? item.loja_nome ?? item.nome_loja ?? "-";
}

function textoIpCaixa(item) {
    return item.ip ?? item.ip_caixa ?? item.endereco_ip ?? "-";
}

function textoObservacao(item) {
    const valor = item.observacao ?? item.obs ?? "";
    return valor ? valor : "-";
}

function setTexto(id, valor) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = valor;
    }
}

function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) {
        el.innerHTML = html;
    }
}

function atualizarMensagemFiltro(texto = "") {
    const mensagem = document.getElementById("mensagem-filtro-caixas");

    if (!mensagem) {
        return;
    }

    if (!texto) {
        mensagem.style.display = "none";
        mensagem.textContent = "";
        return;
    }

    mensagem.style.display = "block";
    mensagem.textContent = texto;
}

function atualizarVisualFiltroOffline(ativo) {
    const cardOffline = document.getElementById("card_caixas_offline");
    const badgeFiltro = document.getElementById("badge_filtro_offline");

    if (!cardOffline) {
        return;
    }

    cardOffline.classList.toggle("offline-filter-active", ativo);
    cardOffline.setAttribute(
        "title",
        ativo ? "Clique para voltar à lista completa" : "Clique para ver somente os caixas offline"
    );

    if (badgeFiltro) {
        badgeFiltro.hidden = !ativo;
    }
}

function caixasFiltrados() {
    return caixasAtuais.filter(caixa => {
        const correspondeStatus = !mostrandoApenasOffline
            || normalizarTexto(caixa.status) === "offline";
        const correspondeObservacao = !filtroObservacao
            || normalizarTexto(textoObservacao(caixa)).includes(filtroObservacao);

        return correspondeStatus && correspondeObservacao;
    });
}

function atualizarMensagemDosFiltros() {
    const filtrosAtivos = [];

    if (mostrandoApenasOffline) {
        filtrosAtivos.push("caixas offline");
    }

    if (filtroObservacao) {
        filtrosAtivos.push(`observação contendo "${filtroObservacao}"`);
    }

    if (filtrosAtivos.length === 0) {
        atualizarMensagemFiltro("");
        return;
    }

    const totalExibido = caixasFiltrados().length;
    atualizarMensagemFiltro(
        `Filtros ativos: ${filtrosAtivos.join(" e ")}. ${totalExibido} caixa(s) encontrado(s).`
    );
}

function zerarTela() {
    caixasAtuais = [];
    mostrandoApenasOffline = false;

    atualizarVisualFiltroOffline(false);
    atualizarMensagemFiltro("");

    setTexto("loja_selecionada", "-");
    setTexto("total_caixas", "0");
    setTexto("caixas_online", "0");
    setTexto("caixas_offline", "0");
    setTexto("status_loja", "-");
    setTexto("ip_loja", "-");
    setTexto("ultima_verificacao", "-");

    setHtml("tabela_caixas_loja", `
        <tr>
            <td colspan="5" class="empty-row">Selecione uma loja.</td>
        </tr>
    `);
}

function montarTabelaCaixas(caixas) {
    if (!caixas || caixas.length === 0) {
        return `
            <tr>
                <td colspan="5" class="empty-row">
                    <div class="empty-state">
                        <i class="fa-regular fa-folder-open"></i>
                        <span>Nenhum caixa encontrado.</span>
                    </div>
                </td>
            </tr>
        `;
    }

    return caixas.map(item => {
        const nomeCaixa = escaparHtml(textoCaixa(item));
        const nomeLoja = escaparHtml(textoLoja(item));
        const ipCaixa = escaparHtml(textoIpCaixa(item));
        const observacao = escaparHtml(textoObservacao(item));

        return `
            <tr>
                <td class="col-loja">${nomeLoja}</td>
                <td class="col-caixa">${nomeCaixa}</td>
                <td class="col-ip-caixa">${ipCaixa}</td>
                <td class="col-observacao">${observacao}</td>
                <td class="col-status">${badgeStatusCaixa(item.status)}</td>
            </tr>
        `;
    }).join("");
}

function atualizarTituloTabela(titulo, subtitulo) {
    const tituloEl = document.querySelector(".section-header h2");
    const subtituloEl = document.querySelector(".section-header p");

    if (tituloEl) {
        tituloEl.textContent = titulo;
    }

    if (subtituloEl) {
        subtituloEl.textContent = subtitulo;
    }
}

function renderizarTabelaFiltrada() {
    setHtml("tabela_caixas_loja", montarTabelaCaixas(caixasFiltrados()));
    atualizarMensagemDosFiltros();

    if (mostrandoApenasOffline) {
        atualizarTituloTabela(
            "Caixas offline",
            "Lista filtrada com os caixas que não responderam no último monitoramento."
        );
        return;
    }

    atualizarTituloTabela(
        "Caixas da loja",
        "Visualização individual dos caixas da loja selecionada"
    );
}

function mostrarTabelaNormal() {
    mostrandoApenasOffline = false;
    atualizarVisualFiltroOffline(false);
    renderizarTabelaFiltrada();
}

function mostrarSomenteOffline() {
    mostrandoApenasOffline = true;
    atualizarVisualFiltroOffline(true);
    renderizarTabelaFiltrada();
}

function alternarFiltroOffline() {
    if (!caixasAtuais || caixasAtuais.length === 0) {
        return;
    }

    if (mostrandoApenasOffline) {
        mostrarTabelaNormal();
    } else {
        mostrarSomenteOffline();
    }
}

function aplicarFiltroObservacao(event) {
    filtroObservacao = normalizarTexto(event.target.value);
    renderizarTabelaFiltrada();
}

async function buscarDadosLoja(nomeLoja) {
    const response = await fetch(`/api/caixas/loja?loja=${encodeURIComponent(nomeLoja)}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
            "Accept": "application/json"
        }
    });

    if (response.status === 401 || response.status === 403) {
        window.location.href = "/login";
        return null;
    }

    if (!response.ok) {
        throw new Error(`Erro HTTP ${response.status}`);
    }

    return await response.json();
}

function aplicarResumo(data, nomeLoja) {
    const caixas = (data.caixas || []).map(caixa => ({
        ...caixa,
        loja: data.loja ?? caixa.loja ?? nomeLoja ?? "-"
    }));

    caixasAtuais = caixas;

    const total = Number(data.total_caixas ?? caixas.length ?? 0);
    const online = Number(data.caixas_online ?? caixas.filter(c => normalizarTexto(c.status) === "online").length);
    const offline = Number(data.caixas_offline ?? caixas.filter(c => normalizarTexto(c.status) === "offline").length);

    setTexto("ultima_verificacao", data.ultima_verificacao ?? "-");
    setTexto("loja_selecionada", data.loja ?? nomeLoja ?? "-");
    setTexto("total_caixas", total);
    setTexto("caixas_online", online);
    setTexto("caixas_offline", offline);
    setTexto("status_loja", data.status_loja ?? (offline > 0 ? "Atenção" : "Online"));
    setTexto("ip_loja", data.ip ?? "-");

    renderizarTabelaFiltrada();
}

async function carregarCaixasLoja(nomeLoja) {
    try {
        setTexto("loja_selecionada", nomeLoja);
        setHtml("tabela_caixas_loja", `
            <tr>
                <td colspan="5" class="empty-row">Carregando caixas...</td>
            </tr>
        `);

        const data = await buscarDadosLoja(nomeLoja);

        if (data) {
            aplicarResumo(data, nomeLoja);
        }
    } catch (error) {
        console.error("Falha ao carregar caixas da loja:", error);
        setTexto("ultima_verificacao", "Erro");
        setHtml("tabela_caixas_loja", `
            <tr>
                <td colspan="5" class="empty-row">Erro ao carregar os dados da loja.</td>
            </tr>
        `);
    }
}

async function carregarTodasAsLojas() {
    try {
        const selectLoja = document.getElementById("select_loja");

        const lojas = Array.from(selectLoja.options)
            .map(option => option.value)
            .filter(value => value && value !== "TODAS");

        setTexto("loja_selecionada", "Todas");
        setTexto("status_loja", "Carregando...");
        setTexto("ip_loja", "-");
        setTexto("ultima_verificacao", "Carregando...");
        atualizarMensagemFiltro("");

        setHtml("tabela_caixas_loja", `
            <tr>
                <td colspan="5" class="empty-row">Carregando todas as lojas...</td>
            </tr>
        `);

        if (lojas.length === 0) {
            caixasAtuais = [];
            setTexto("ultima_verificacao", "-");
            setTexto("total_caixas", "0");
            setTexto("caixas_online", "0");
            setTexto("caixas_offline", "0");
            setTexto("status_loja", "-");

            setHtml("tabela_caixas_loja", `
                <tr>
                    <td colspan="5" class="empty-row">Nenhuma loja encontrada no seletor.</td>
                </tr>
            `);
            return;
        }

        const resultados = await Promise.all(lojas.map(async loja => {
            try {
                const data = await buscarDadosLoja(loja);
                return data ? { ...data, loja_nome_original: loja } : null;
            } catch (error) {
                console.error(`Falha ao carregar loja ${loja}:`, error);
                return {
                    loja,
                    total_caixas: 0,
                    caixas_online: 0,
                    caixas_offline: 0,
                    ultima_verificacao: "-",
                    caixas: []
                };
            }
        }));

        let totalCaixas = 0;
        let caixasOnline = 0;
        let caixasOffline = 0;
        let ultimaVerificacao = "-";
        const todosCaixas = [];

        resultados.forEach(data => {
            if (!data) {
                return;
            }

            const caixas = data.caixas || [];
            const total = Number(data.total_caixas ?? caixas.length ?? 0);
            const online = Number(data.caixas_online ?? caixas.filter(c => normalizarTexto(c.status) === "online").length);
            const offline = Number(data.caixas_offline ?? caixas.filter(c => normalizarTexto(c.status) === "offline").length);

            totalCaixas += total;
            caixasOnline += online;
            caixasOffline += offline;

            if (data.ultima_verificacao && data.ultima_verificacao !== "-") {
                ultimaVerificacao = data.ultima_verificacao;
            }

            caixas.forEach(caixa => {
                todosCaixas.push({
                    ...caixa,
                    loja: data.loja ?? data.loja_nome_original ?? textoLoja(caixa)
                });
            });
        });

        caixasAtuais = todosCaixas;

        setTexto("ultima_verificacao", ultimaVerificacao);
        setTexto("loja_selecionada", "Todas");
        setTexto("total_caixas", totalCaixas);
        setTexto("caixas_online", caixasOnline);
        setTexto("caixas_offline", caixasOffline);
        setTexto("status_loja", caixasOffline > 0 ? "Atenção" : "Online");
        setTexto("ip_loja", "-");

        renderizarTabelaFiltrada();
    } catch (error) {
        console.error("Falha ao carregar todas as lojas:", error);
        setTexto("ultima_verificacao", "Erro");
        setHtml("tabela_caixas_loja", `
            <tr>
                <td colspan="5" class="empty-row">Erro ao carregar todas as lojas.</td>
            </tr>
        `);
    }
}

async function processarSelecao() {
    const selectLoja = document.getElementById("select_loja");
    const loja = selectLoja.value;

    if (!loja) {
        zerarTela();
        return;
    }

    if (loja === "TODAS") {
        await carregarTodasAsLojas();
        return;
    }

    await carregarCaixasLoja(loja);
}

async function atualizarAutomaticamenteCaixas() {
    if (atualizacaoEmAndamento) {
        return;
    }

    atualizacaoEmAndamento = true;

    try {
        await processarSelecao();
    } finally {
        atualizacaoEmAndamento = false;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const selectLoja = document.getElementById("select_loja");
    const campoObservacao = document.getElementById("filtro_observacao");

    if (!selectLoja) {
        return;
    }

    const jaTemTodas = Array.from(selectLoja.options).some(option => option.value === "TODAS");

    if (!jaTemTodas) {
        const optionTodas = document.createElement("option");
        optionTodas.value = "TODAS";
        optionTodas.textContent = "Todas as lojas";
        selectLoja.insertBefore(optionTodas, selectLoja.options[1] || null);
    }

    const cardOffline = document.getElementById("card_caixas_offline");

    if (cardOffline) {
        cardOffline.classList.add("card-clickable", "card-offline-filter");
        cardOffline.addEventListener("click", alternarFiltroOffline);
    }

    selectLoja.addEventListener("change", processarSelecao);

    if (campoObservacao) {
        campoObservacao.addEventListener("input", aplicarFiltroObservacao);
    }

    atualizarAutomaticamenteCaixas();
    setInterval(atualizarAutomaticamenteCaixas, INTERVALO_ATUALIZACAO_MS);
});
