let dadosVersoes = null;
let registrosVersoes = [];
let graficoVersoesPizza = null;

const textoSeguro = valor => String(valor ?? "").replace(/[&<>'"]/g, caractere => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[caractere]));

function montarRegistros() {
    registrosVersoes = [];
    (dadosVersoes?.lojas || []).forEach(loja => {
        if (loja.caixas.length) {
            loja.caixas.forEach(caixa => registrosVersoes.push({...caixa, loja: loja.loja, ip: loja.ip, sucesso: true, erro: ""}));
        } else {
            registrosVersoes.push({loja: loja.loja, ip: loja.ip, caixa: "-", versao: "-", sucesso: false, erro: loja.erro || "Nenhum caixa retornado."});
        }
    });
}

function preencherSelect(id, valores, rotulo) {
    const select = document.querySelector(id);
    const selecionado = select.value;
    select.innerHTML = `<option value="">${rotulo}</option>` + valores.map(valor => `<option value="${textoSeguro(valor)}">${textoSeguro(valor)}</option>`).join("");
    if (valores.includes(selecionado)) select.value = selecionado;
}

function preencherFiltros() {
    const lojas = [...new Set(registrosVersoes.map(item => item.loja).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", {numeric:true}));
    const versoes = [...new Set(registrosVersoes.filter(item => item.sucesso).map(item => item.versao).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", {numeric:true}));
    preencherSelect("#filtro-loja-bi", lojas, "Todas as lojas");
    preencherSelect("#filtro-versao-bi", versoes, "Todas as versões");
}

function registrosFiltrados(incluirErros = false) {
    const loja = document.querySelector("#filtro-loja-bi").value;
    const versao = document.querySelector("#filtro-versao-bi").value;
    return registrosVersoes.filter(item => {
        if (!incluirErros && !item.sucesso) return false;
        if (loja && item.loja !== loja) return false;
        if (versao && (!item.sucesso || item.versao !== versao)) return false;
        return true;
    });
}

function agrupar(lista, campo) {
    return lista.reduce((resultado, item) => {
        const chave = item[campo] || "Sem informação";
        resultado[chave] = (resultado[chave] || 0) + 1;
        return resultado;
    }, {});
}

function registrosDaPizza() {
    const loja = document.querySelector("#filtro-loja-bi").value;
    return registrosVersoes.filter(item => item.sucesso && (!loja || item.loja === loja));
}

function corPizza(indice, selecionada, versao, versaoAtiva) {
    const paleta = [
        [38, 183, 232], [43, 221, 160], [167, 139, 250], [255, 191, 75],
        [255, 96, 125], [58, 139, 253], [34, 211, 238], [244, 114, 182],
        [132, 204, 22], [251, 146, 60], [129, 140, 248], [45, 212, 191]
    ];
    const [r, g, b] = paleta[indice % paleta.length];
    const opacidade = selecionada && versaoAtiva && versao !== versaoAtiva ? 0.22 : 0.88;
    return `rgba(${r},${g},${b},${opacidade})`;
}

function indiceCorVersao(versao) {
    const versoes = [...new Set(registrosVersoes.filter(item => item.sucesso).map(item => item.versao).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "pt-BR", {numeric:true}));
    return Math.max(0, versoes.indexOf(versao));
}

function estiloVersao(versao) {
    const paleta = [
        [38,183,232], [43,221,160], [167,139,250], [255,191,75],
        [255,96,125], [58,139,253], [34,211,238], [244,114,182],
        [132,204,22], [251,146,60], [129,140,248], [45,212,191]
    ];
    const [r,g,b] = paleta[indiceCorVersao(versao) % paleta.length];
    return `--versao-cor:rgb(${r},${g},${b});--versao-fundo:rgba(${r},${g},${b},.13);--versao-borda:rgba(${r},${g},${b},.42)`;
}

function selecionarVersaoPelaPizza(versao) {
    const select = document.querySelector("#filtro-versao-bi");
    select.value = select.value === versao ? "" : versao;
    aplicarFiltros();
}

function renderizarPizza() {
    const agrupamento = agrupar(registrosDaPizza(), "versao");
    const itens = Object.entries(agrupamento).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR", {numeric:true}));
    const labels = itens.map(([versao]) => versao);
    const valores = itens.map(([, total]) => total);
    const versaoAtiva = document.querySelector("#filtro-versao-bi").value;
    const total = valores.reduce((soma, valor) => soma + valor, 0);
    document.querySelector("#pizza-total").textContent = `${total} caixa(s) · ${labels.length} versão(ões)`;
    document.querySelector("#pizza-selecao").innerHTML = versaoAtiva
        ? `<i class="fa-solid fa-filter"></i> Filtrando versão <strong>${textoSeguro(versaoAtiva)}</strong> — clique na fatia novamente para remover`
        : "Todas as versões selecionadas";

    if (graficoVersoesPizza) graficoVersoesPizza.destroy();
    const canvas = document.querySelector("#grafico-versoes-pizza");
    graficoVersoesPizza = new Chart(canvas, {
        type: "pie",
        data: {labels, datasets: [{
            data: valores,
            backgroundColor: labels.map(versao => corPizza(indiceCorVersao(versao), true, versao, versaoAtiva)),
            borderColor: labels.map(versao => versao === versaoAtiva ? "#e9fbff" : "rgba(5,20,40,.8)"),
            borderWidth: labels.map(versao => versao === versaoAtiva ? 3 : 2),
            offset: labels.map(versao => versao === versaoAtiva ? 12 : 0),
            hoverOffset: 10,
        }]},
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (_evento, elementos) => {
                if (elementos.length) selecionarVersaoPelaPizza(labels[elementos[0].index]);
            },
            plugins: {
                legend: {
                    position: window.innerWidth < 700 ? "bottom" : "right",
                    labels: {color: "#b7d0e3", usePointStyle: true, pointStyle: "circle", padding: 16, font: {size: 11, weight: "600"}},
                    onClick: (_evento, item) => selecionarVersaoPelaPizza(labels[item.index]),
                },
                tooltip: {callbacks: {label: contexto => {
                    const percentual = total ? ((contexto.raw / total) * 100).toFixed(1) : "0.0";
                    return ` ${contexto.label}: ${contexto.raw} caixa(s) (${percentual}%)`;
                }}},
            },
        },
    });
}

function renderizarBarras(id, agrupamento, vazio) {
    const itens = Object.entries(agrupamento).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR", {numeric:true}));
    const maior = Math.max(1, ...itens.map(([, total]) => total));
    document.querySelector(id).innerHTML = itens.length ? itens.map(([nome, total]) => `<div class="versao-distribuicao"><div><strong title="${textoSeguro(nome)}">${textoSeguro(nome)}</strong><span>${total} caixa(s)</span></div><div class="versao-barra"><span style="width:${(total / maior) * 100}%"></span></div></div>`).join("") : `<span class="analitico-carregando">${textoSeguro(vazio)}</span>`;
}

function renderizarTabela() {
    const pesquisa = document.querySelector("#filtro-versoes").value.trim().toLowerCase();
    const linhas = registrosFiltrados(true).filter(item => [item.loja, item.ip, item.caixa, item.versao, item.erro].join(" ").toLowerCase().includes(pesquisa));
    document.querySelector("#tabela-versoes").innerHTML = linhas.length ? linhas.map(item => `<tr>
        <td><strong>${textoSeguro(item.loja)}</strong></td><td>${textoSeguro(item.caixa)}</td>
        <td><span class="versao-badge ${item.sucesso ? "" : "erro"}" ${item.sucesso ? `style="${estiloVersao(item.versao)}"` : ""}>${textoSeguro(item.versao)}</span></td>
        <td>${item.sucesso ? '<span class="status-usuario ativo"><i></i>Consultado</span>' : `<span class="analitico-erro" title="${textoSeguro(item.erro)}"><i class="fa-solid fa-circle-exclamation"></i> ${textoSeguro(item.erro)}</span>`}</td>
    </tr>`).join("") : '<tr><td colspan="4">Nenhum resultado para os filtros selecionados.</td></tr>';
}

function aplicarFiltros() {
    if (!dadosVersoes) return;
    const lista = registrosFiltrados(false);
    renderizarPizza();
    renderizarBarras("#distribuicao-lojas", agrupar(lista, "loja"), "Nenhuma loja para os filtros selecionados.");
    renderizarTabela();
    document.querySelector("#analitico-resumo").textContent = `${lista.length} caixa(s), ${new Set(lista.map(item => item.loja)).size} loja(s) e ${new Set(lista.map(item => item.versao)).size} versão(ões) no resultado.`;
}

async function carregarVersoes() {
    const botao = document.querySelector("#atualizar-versoes");
    botao.disabled = true; botao.classList.add("atualizando");
    document.querySelector("#analitico-resumo").textContent = "Consultando os agentes SysPDV...";
    try {
        const resposta = await fetch(`/api/analitico/versoes-syspdv?_=${Date.now()}`, {cache:"no-store", credentials:"same-origin"});
        if (resposta.status === 401 || resposta.status === 403) { location.href = "/login"; return; }
        if (!resposta.ok) throw new Error(`Erro HTTP ${resposta.status}`);
        dadosVersoes = await resposta.json();
        document.querySelector("#analitico-data").textContent = dadosVersoes.ultima_verificacao || "-";
        montarRegistros(); preencherFiltros(); aplicarFiltros();
    } catch (erro) {
        document.querySelector("#analitico-resumo").textContent = "Falha ao carregar a análise de versões.";
        document.querySelector("#tabela-versoes").innerHTML = `<tr><td colspan="4">${textoSeguro(erro.message)}</td></tr>`;
    } finally { botao.disabled = false; botao.classList.remove("atualizando"); }
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#atualizar-versoes").addEventListener("click", carregarVersoes);
    document.querySelector("#filtro-loja-bi").addEventListener("change", aplicarFiltros);
    document.querySelector("#filtro-versao-bi").addEventListener("change", aplicarFiltros);
    document.querySelector("#filtro-versoes").addEventListener("input", renderizarTabela);
    document.querySelector("#limpar-filtros-bi").addEventListener("click", () => {
        document.querySelector("#filtro-loja-bi").value = "";
        document.querySelector("#filtro-versao-bi").value = "";
        document.querySelector("#filtro-versoes").value = "";
        aplicarFiltros();
    });
    carregarVersoes();
});
