let dadosNfce = null;
const seguroNfce = valor => String(valor ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

function preencherLojasNfce() {
    const select = document.querySelector("#filtro-loja-nfce");
    const atual = select.value;
    const lojas = dadosNfce.lojas.map(item => item.loja);
    select.innerHTML = '<option value="">Todas as lojas</option>' + lojas.map(loja => `<option value="${seguroNfce(loja)}">${seguroNfce(loja)}</option>`).join("");
    if (lojas.includes(atual)) select.value = atual;
}

function lojasNfceFiltradas() {
    const loja = document.querySelector("#filtro-loja-nfce").value;
    const status = document.querySelector("#filtro-status-nfce").value;
    return dadosNfce.lojas.filter(item => {
        if (loja && item.loja !== loja) return false;
        if (status === "pendentes" && item.pendentes <= 0) return false;
        if (status === "rejeitadas" && item.rejeitadas <= 0) return false;
        if (status === "com_ocorrencia" && item.pendentes + item.rejeitadas <= 0) return false;
        return true;
    });
}

function renderizarNfce() {
    if (!dadosNfce) return;
    const lojas = lojasNfceFiltradas();
    const status = document.querySelector("#filtro-status-nfce").value;
    const pendentes = lojas.reduce((soma, item) => soma + item.pendentes, 0);
    const rejeitadas = lojas.reduce((soma, item) => soma + item.rejeitadas, 0);
    document.querySelector("#total-nfce-pendentes").textContent = pendentes;
    document.querySelector("#total-nfce-rejeitadas").textContent = rejeitadas;
    document.querySelector("#total-nfce-lojas").textContent = lojas.filter(item => item.banco_online).length;
    document.querySelector("#total-nfce-lojas-contexto").textContent = `de ${dadosNfce.total_lojas} loja(s)`;
    document.querySelectorAll("[data-filtro-nfce]").forEach(card => card.classList.toggle("is-active", card.dataset.filtroNfce === status));
    document.querySelector("#nfce-resumo-texto").textContent = `${lojas.length} loja(s), ${pendentes} pendente(s) e ${rejeitadas} rejeitada(s) no resultado.`;

    document.querySelector("#nfce-lojas-grid").innerHTML = lojas.length ? lojas.map(item => {
        const total = item.pendentes + item.rejeitadas;
        const classe = !item.banco_online ? "erro" : total ? "alerta" : "ok";
        return `<article class="nfce-loja-card ${classe}">
            <header><div><i class="fa-solid fa-store"></i><span><strong>${seguroNfce(item.loja)}</strong><small>${item.banco_online ? "Banco consultado" : "Consulta indisponível"}</small></span></div><b>${item.banco_online ? total + " ocorrência(s)" : "Sem dados"}</b></header>
            ${item.banco_online ? `<div class="nfce-loja-metricas"><div class="pendente"><span>Pendentes</span><strong>${item.pendentes}</strong><small>PE</small></div><div class="rejeitada"><span>Rejeitadas</span><strong>${item.rejeitadas}</strong><small>RJ</small></div></div>` : `<div class="nfce-loja-erro"><i class="fa-solid fa-triangle-exclamation"></i><span>${seguroNfce(item.erro)}</span></div>`}
        </article>`;
    }).join("") : '<div class="analitico-carregando">Nenhuma loja corresponde aos filtros selecionados.</div>';
}

function selecionarFiltroNfce(filtro) {
    const select = document.querySelector("#filtro-status-nfce");
    select.value = select.value === filtro ? "todos" : filtro;
    renderizarNfce();
}

async function carregarNfce() {
    const botao = document.querySelector("#atualizar-nfce");
    botao.disabled = true; botao.classList.add("atualizando");
    try {
        const resposta = await fetch(`/api/analitico/nfce-lojas?_=${Date.now()}`, {cache:"no-store",credentials:"same-origin"});
        if (resposta.status === 401 || resposta.status === 403) { location.href="/login"; return; }
        if (!resposta.ok) throw new Error(`Erro HTTP ${resposta.status}`);
        dadosNfce = await resposta.json();
        document.querySelector("#nfce-data").textContent = dadosNfce.ultima_verificacao || "-";
        preencherLojasNfce(); renderizarNfce();
    } catch (erro) {
        document.querySelector("#nfce-resumo-texto").textContent = `Falha ao consultar NFC-e: ${erro.message}`;
    } finally { botao.disabled=false; botao.classList.remove("atualizando"); }
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#filtro-loja-nfce").addEventListener("change", renderizarNfce);
    document.querySelector("#filtro-status-nfce").addEventListener("change", renderizarNfce);
    document.querySelector("#atualizar-nfce").addEventListener("click", carregarNfce);
    document.querySelector("#limpar-filtros-nfce").addEventListener("click", () => {document.querySelector("#filtro-loja-nfce").value="";document.querySelector("#filtro-status-nfce").value="todos";renderizarNfce();});
    document.querySelectorAll("[data-filtro-nfce]").forEach(card => {card.addEventListener("click",()=>selecionarFiltroNfce(card.dataset.filtroNfce));card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();selecionarFiltroNfce(card.dataset.filtroNfce);}});});
    carregarNfce();
});
