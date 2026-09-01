let modoEdicao = false;
let tipoEdicao = null;
let idEdicao = null;

let lojasCadastradas = [];
let caixasCadastrados = [];
let caixasSelecionadosExclusao = new Set();
let filtroLojaCaixas = "";
let totalCaixasCadastrados = 0;
let carregamentoCaixasAtual = null;

const cadastroPaginacao = {
    lojas: { pagina: 1, porPagina: 5 },
    caixas: { pagina: 1, porPagina: 20 }
};

function escaparHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function totalPaginasCadastro(total, porPagina) {
    return Math.max(1, Math.ceil(total / porPagina));
}

function obterPaginaCadastro(lista, tipo) {
    const estado = cadastroPaginacao[tipo];
    const totalPaginas = totalPaginasCadastro(lista.length, estado.porPagina);

    if (estado.pagina > totalPaginas) {
        estado.pagina = totalPaginas;
    }

    if (estado.pagina < 1) {
        estado.pagina = 1;
    }

    const inicio = (estado.pagina - 1) * estado.porPagina;
    return lista.slice(inicio, inicio + estado.porPagina);
}

function montarBotoesPaginacao(tipo, total) {
    const estado = cadastroPaginacao[tipo];
    const totalPaginas = totalPaginasCadastro(total, estado.porPagina);
    const container = document.getElementById(`paginacao_${tipo}`);
    const info = document.getElementById(`info_paginacao_${tipo}`);

    if (!container || !info) {
        return;
    }

    if (total === 0) {
        container.innerHTML = '';
        info.textContent = 'Nenhum registro encontrado';
        return;
    }

    const inicio = (estado.pagina - 1) * estado.porPagina + 1;
    const fim = Math.min(estado.pagina * estado.porPagina, total);
    info.textContent = `Mostrando ${inicio} a ${fim} de ${total} registros — Página ${estado.pagina} de ${totalPaginas}`;

    let html = `
        <span class="pagination-current" aria-live="polite">Página <strong>${estado.pagina}</strong> de ${totalPaginas}</span>
        <button type="button" class="pagination-btn" data-cadastro-acao="pagina" data-tipo="${tipo}" data-pagina="${estado.pagina - 1}" ${estado.pagina === 1 ? 'disabled' : ''}>Anterior</button>
    `;

    const paginas = [];
    for (let i = 1; i <= totalPaginas; i++) {
        if (i === 1 || i === totalPaginas || Math.abs(i - estado.pagina) <= 1) {
            paginas.push(i);
        }
    }

    let anterior = 0;
    paginas.forEach((pagina) => {
        if (pagina - anterior > 1) {
            html += '<span class="pagination-dots">...</span>';
        }

        html += `
            <button type="button" class="pagination-btn ${pagina === estado.pagina ? 'active' : ''}" data-cadastro-acao="pagina" data-tipo="${tipo}" data-pagina="${pagina}" aria-label="${pagina === estado.pagina ? `Página atual, ${pagina}` : `Ir para a página ${pagina}`}" title="${pagina === estado.pagina ? `Página atual: ${pagina}` : `Ir para a página ${pagina}`}" ${pagina === estado.pagina ? 'aria-current="page"' : ''}>${pagina}</button>
        `;
        anterior = pagina;
    });

    html += `
        <button type="button" class="pagination-btn" data-cadastro-acao="pagina" data-tipo="${tipo}" data-pagina="${estado.pagina + 1}" ${estado.pagina === totalPaginas ? 'disabled' : ''}>Próxima</button>
    `;

    container.innerHTML = html;
}

function trocarPaginaCadastro(tipo, pagina) {
    const estado = cadastroPaginacao[tipo];
    const total = tipo === 'lojas' ? lojasCadastradas.length : totalCaixasCadastrados;
    const totalPaginas = totalPaginasCadastro(total, estado.porPagina);

    estado.pagina = Math.min(Math.max(1, pagina), totalPaginas);

    if (tipo === 'lojas') {
        renderizarTabelaLojas();
    } else {
        carregarCaixasCadastrados();
    }
}

function alterarItensPorPaginaCadastro(tipo, valor) {
    const estado = cadastroPaginacao[tipo];
    estado.porPagina = Number(valor) || 5;
    estado.pagina = 1;

    if (tipo === 'lojas') {
        renderizarTabelaLojas();
    } else {
        carregarCaixasCadastrados();
    }
}

function renderizarTabelaLojas() {
    const lojasPagina = obterPaginaCadastro(lojasCadastradas, 'lojas');
    document.getElementById('tabela_lojas_cadastradas').innerHTML = montarTabelaLojas(lojasPagina);
    montarBotoesPaginacao('lojas', lojasCadastradas.length);
}

function renderizarTabelaCaixas() {
    document.getElementById('tabela_caixas_cadastrados').innerHTML = montarTabelaCaixas(caixasCadastrados);
    montarBotoesPaginacao('caixas', totalCaixasCadastrados);
    atualizarControlesExclusaoCaixas();
}

function filtrarCaixasPorLoja(valorLoja) {
    filtroLojaCaixas = valorLoja || '';
    cadastroPaginacao.caixas.pagina = 1;
    caixasSelecionadosExclusao.clear();
    carregarCaixasCadastrados();
}


function mostrarMensagem(texto, tipo = 'ok') {
    const box = document.getElementById('cadastro-mensagem');
    box.textContent = texto;
    box.className = `cadastro-mensagem ${tipo}`;
}

function limparMensagem() {
    const box = document.getElementById('cadastro-mensagem');
    box.textContent = '';
    box.className = 'cadastro-mensagem';
}

function montarTabelaLojas(lojas) {
    if (!lojas || lojas.length === 0) {
        return `<tr><td colspan="6">Nenhuma loja cadastrada.</td></tr>`;
    }

    return lojas.map(loja => `
        <tr>
            <td>${escaparHtml(loja.nome ?? '-')}</td>
            <td>${escaparHtml(loja.ip ?? '-')}</td>
            <td>${escaparHtml(loja.observacao ?? '')}</td>
            <td>${escaparHtml(loja.criado_por ?? '')}</td>
            <td>${escaparHtml(loja.criado_em ?? '')}</td>
            <td>
                <button type="button" class="cadastro-btn-small" data-cadastro-acao="editar-loja" data-id="${Number(loja.id)}">Alterar</button>
                <button type="button" class="cadastro-btn-small danger" data-cadastro-acao="excluir-loja" data-id="${Number(loja.id)}">Excluir</button>
            </td>
        </tr>
    `).join('');
}


function badgeStatusCadastro(valor) {
    const texto = (valor || 'offline').toString().trim().toLowerCase();

    if (texto === 'online') {
        return '<span class="badge badge-online">online</span>';
    }

    if (texto === 'erro') {
        return '<span class="badge badge-warning">erro</span>';
    }

    return '<span class="badge badge-offline">offline</span>';
}

function montarTabelaCaixas(caixas) {
    if (!caixas || caixas.length === 0) {
        return `<tr><td colspan="7">Nenhum caixa cadastrado.</td></tr>`;
    }

    return caixas.map(caixa => `
        <tr>
            <td class="col-checkbox">
                <input type="checkbox" class="check-caixa-exclusao" value="${Number(caixa.id)}" data-cadastro-acao="selecionar-caixa" data-id="${Number(caixa.id)}" ${caixasSelecionadosExclusao.has(Number(caixa.id)) ? 'checked' : ''}>
            </td>
            <td>${escaparHtml(caixa.loja_nome ?? '-')}</td>
            <td>${escaparHtml(caixa.nome ?? '-')}</td>
            <td>${escaparHtml(caixa.ip ?? '')}</td>
            <td>${badgeStatusCadastro(caixa.status)}</td>
            <td>${escaparHtml(caixa.observacao ?? '')}</td>
            <td>
                <button type="button" class="cadastro-btn-small" data-cadastro-acao="editar-caixa" data-id="${Number(caixa.id)}">Alterar</button>
                <button type="button" class="cadastro-btn-small danger" data-cadastro-acao="excluir-caixa" data-id="${Number(caixa.id)}">Excluir</button>
            </td>
        </tr>
    `).join('');
}


function alternarSelecaoCaixaExclusao(id, marcado) {
    const caixaId = Number(id);

    if (marcado) {
        caixasSelecionadosExclusao.add(caixaId);
    } else {
        caixasSelecionadosExclusao.delete(caixaId);
    }

    atualizarControlesExclusaoCaixas();
}

function inicializarAcoesDinamicasCadastro() {
    const pagina = document.querySelector('.main-content');
    if (!pagina) return;

    pagina.addEventListener('click', (event) => {
        const botao = event.target.closest('button[data-cadastro-acao]');
        if (!botao || !pagina.contains(botao) || botao.disabled) return;

        const acao = botao.dataset.cadastroAcao;
        const id = Number(botao.dataset.id);

        if (acao === 'pagina') {
            const tipo = botao.dataset.tipo;
            const numeroPagina = Number(botao.dataset.pagina);
            if ((tipo === 'lojas' || tipo === 'caixas') && Number.isInteger(numeroPagina)) {
                trocarPaginaCadastro(tipo, numeroPagina);
            }
            return;
        }

        if (!Number.isInteger(id) || id <= 0) return;

        if (acao === 'editar-loja') {
            const loja = lojasCadastradas.find(item => Number(item.id) === id);
            if (loja) editarLoja(loja);
        } else if (acao === 'excluir-loja') {
            excluirLoja(id);
        } else if (acao === 'editar-caixa') {
            const caixa = caixasCadastrados.find(item => Number(item.id) === id);
            if (caixa) editarCaixa(caixa);
        } else if (acao === 'excluir-caixa') {
            excluirCaixa(id);
        }
    });

    pagina.addEventListener('change', (event) => {
        const check = event.target.closest('input[data-cadastro-acao="selecionar-caixa"]');
        if (!check || !pagina.contains(check)) return;

        const id = Number(check.dataset.id);
        if (Number.isInteger(id) && id > 0) {
            alternarSelecaoCaixaExclusao(id, check.checked);
        }
    });
}

function idsCaixasDaPaginaAtual() {
    return caixasCadastrados.map(caixa => Number(caixa.id));
}

function selecionarCaixasPagina(marcado) {
    idsCaixasDaPaginaAtual().forEach(id => {
        if (marcado) {
            caixasSelecionadosExclusao.add(id);
        } else {
            caixasSelecionadosExclusao.delete(id);
        }
    });

    renderizarTabelaCaixas();
}

async function selecionarTodosCaixasLojaAtual() {
    const selectLoja = document.getElementById('select_loja_excluir_caixas');
    const lojaId = selectLoja ? selectLoja.value : '';

    if (!lojaId) {
        mostrarMensagem('Selecione uma loja para marcar todos os caixas dela.', 'erro');
        return;
    }

    const response = await fetch(`/api/cadastro/caixas?loja_id=${encodeURIComponent(lojaId)}&somente_ids=1`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
    });
    const data = await response.json();

    if (!response.ok) {
        mostrarMensagem(data.erro || 'Erro ao selecionar os caixas da loja.', 'erro');
        return;
    }

    filtroLojaCaixas = lojaId;
    cadastroPaginacao.caixas.pagina = 1;
    caixasSelecionadosExclusao = new Set((data.ids || []).map(id => Number(id)));
    await carregarCaixasCadastrados();
}

function limparSelecaoCaixasExclusao() {
    caixasSelecionadosExclusao.clear();
    renderizarTabelaCaixas();
}

function atualizarControlesExclusaoCaixas() {
    const contador = document.getElementById('contador_caixas_exclusao');
    const btnExcluir = document.getElementById('btn-excluir-caixas-selecionados');
    const checkPagina = document.getElementById('check_todos_caixas_pagina');
    const total = caixasSelecionadosExclusao.size;

    if (contador) {
        contador.textContent = `${total} caixa(s) selecionado(s)`;
    }

    if (btnExcluir) {
        btnExcluir.disabled = total === 0;
    }

    if (checkPagina) {
        const idsPagina = idsCaixasDaPaginaAtual();
        const todosMarcados = idsPagina.length > 0 && idsPagina.every(id => caixasSelecionadosExclusao.has(id));
        const algumMarcado = idsPagina.some(id => caixasSelecionadosExclusao.has(id));

        checkPagina.checked = todosMarcados;
        checkPagina.indeterminate = algumMarcado && !todosMarcados;
    }
}

async function excluirCaixasSelecionados() {
    const ids = Array.from(caixasSelecionadosExclusao);

    if (ids.length === 0) {
        mostrarMensagem('Selecione pelo menos um caixa para excluir.', 'erro');
        return;
    }

    if (!confirm(`Deseja excluir ${ids.length} caixa(s) selecionado(s)?`)) {
        return;
    }

    const response = await fetch('/api/cadastro/caixas/excluir-lote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
    });

    const data = await response.json();

    if (!response.ok) {
        mostrarMensagem(data.erro || 'Erro ao excluir caixas selecionados.', 'erro');
        return;
    }

    caixasSelecionadosExclusao.clear();
    mostrarMensagem(data.mensagem || 'Caixas excluídos com sucesso.', 'ok');
    await carregarCaixasCadastrados();
    resetFormulario();
}

async function carregarLojasCadastradas() {
    const response = await fetch('/api/cadastro/lojas', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
    });

    const data = await response.json();
    lojasCadastradas = data.lojas || [];
    renderizarTabelaLojas();
}

async function carregarCaixasCadastrados() {
    if (carregamentoCaixasAtual) {
        carregamentoCaixasAtual.abort();
    }

    carregamentoCaixasAtual = new AbortController();
    const estado = cadastroPaginacao.caixas;
    const params = new URLSearchParams({
        pagina: String(estado.pagina),
        por_pagina: String(estado.porPagina)
    });

    if (filtroLojaCaixas) {
        params.set('loja_id', filtroLojaCaixas);
    }

    const tabela = document.getElementById('tabela_caixas_cadastrados');
    tabela.innerHTML = '<tr><td colspan="7">Carregando...</td></tr>';

    let response;
    try {
        response = await fetch(`/api/cadastro/caixas?${params.toString()}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' },
            signal: carregamentoCaixasAtual.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') return;
        tabela.innerHTML = '<tr><td colspan="7">Falha ao carregar os caixas.</td></tr>';
        return;
    }

    const data = await response.json();

    if (!response.ok) {
        tabela.innerHTML = '<tr><td colspan="7">Falha ao carregar os caixas.</td></tr>';
        return;
    }

    caixasCadastrados = Array.isArray(data.caixas) ? data.caixas : [];
    totalCaixasCadastrados = Number(data.total) || 0;
    estado.pagina = Number(data.pagina) || 1;
    renderizarTabelaCaixas();
}

function atualizarFormulario() {
    const tipo = document.getElementById('tipo').value;
    const blocoLoja = document.getElementById('bloco-loja-relacionada');
    blocoLoja.style.display = tipo === 'caixa' ? 'block' : 'none';
}


function irParaFormularioCadastro() {
    const form = document.getElementById('form-cadastro');
    if (!form) return;

    form.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
    });

    const primeiroCampo = document.getElementById('tipo');
    if (primeiroCampo) {
        setTimeout(() => primeiroCampo.focus(), 450);
    }
}

function resetFormulario() {
    document.getElementById('form-cadastro').reset();
    document.getElementById('tipo').value = 'loja';
    atualizarFormulario();
    modoEdicao = false;
    tipoEdicao = null;
    idEdicao = null;
    document.getElementById('btn-salvar').textContent = 'Salvar';
    limparMensagem();
}

function editarLoja(loja) {
    modoEdicao = true;
    tipoEdicao = 'loja';
    idEdicao = loja.id;

    document.getElementById('tipo').value = 'loja';
    atualizarFormulario();
    document.getElementById('nome').value = loja.nome ?? '';
    document.getElementById('ip').value = loja.ip ?? '';
    document.getElementById('obs').value = loja.observacao ?? '';
    document.getElementById('btn-salvar').textContent = 'Alterar Loja';
    mostrarMensagem('Editando loja selecionada.', 'ok');
    irParaFormularioCadastro();
}


function editarCaixa(caixa) {
    modoEdicao = true;
    tipoEdicao = 'caixa';
    idEdicao = caixa.id;

    document.getElementById('tipo').value = 'caixa';
    atualizarFormulario();
    document.getElementById('loja_id').value = caixa.loja_id ?? '';
    document.getElementById('nome').value = caixa.nome ?? '';
    document.getElementById('ip').value = caixa.ip ?? '';
    document.getElementById('obs').value = caixa.observacao ?? '';
    document.getElementById('btn-salvar').textContent = 'Alterar Caixa';
    mostrarMensagem('Editando caixa selecionado.', 'ok');
    irParaFormularioCadastro();
}


async function excluirLoja(id) {
    if (!confirm('Deseja excluir esta loja? Os caixas vinculados também serão excluídos.')) {
        return;
    }

    const response = await fetch(`/api/cadastro/loja/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
    });

    const data = await response.json();

    if (!response.ok) {
        mostrarMensagem(data.erro || 'Erro ao excluir loja.', 'erro');
        return;
    }

    mostrarMensagem(data.mensagem || 'Loja excluída com sucesso.', 'ok');
    await carregarLojasCadastradas();
    await carregarCaixasCadastrados();
    resetFormulario();
}

async function excluirCaixa(id) {
    if (!confirm('Deseja excluir este caixa?')) {
        return;
    }

    const response = await fetch(`/api/cadastro/caixa/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
    });

    const data = await response.json();

    if (!response.ok) {
        mostrarMensagem(data.erro || 'Erro ao excluir caixa.', 'erro');
        return;
    }

    mostrarMensagem(data.mensagem || 'Caixa excluído com sucesso.', 'ok');
    await carregarCaixasCadastrados();
    resetFormulario();
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('form-cadastro');
    const tipo = document.getElementById('tipo');

    inicializarAcoesDinamicasCadastro();
    atualizarFormulario();
    tipo.addEventListener('change', atualizarFormulario);

    carregarLojasCadastradas();
    carregarCaixasCadastrados();

    const itensLojas = document.getElementById('itens_por_pagina_lojas');
    const itensCaixas = document.getElementById('itens_por_pagina_caixas');

    if (itensLojas) {
        itensLojas.addEventListener('change', (event) => alterarItensPorPaginaCadastro('lojas', event.target.value));
    }

    if (itensCaixas) {
        itensCaixas.addEventListener('change', (event) => alterarItensPorPaginaCadastro('caixas', event.target.value));
    }

    const checkTodosPagina = document.getElementById('check_todos_caixas_pagina');
    const btnMarcarLoja = document.getElementById('btn-marcar-caixas-loja');
    const btnLimparSelecao = document.getElementById('btn-limpar-selecao-caixas');
    const btnExcluirSelecionados = document.getElementById('btn-excluir-caixas-selecionados');
    const selectLojaExcluirCaixas = document.getElementById('select_loja_excluir_caixas');

    if (checkTodosPagina) {
        checkTodosPagina.addEventListener('change', (event) => selecionarCaixasPagina(event.target.checked));
    }

    if (selectLojaExcluirCaixas) {
        selectLojaExcluirCaixas.addEventListener('change', (event) => filtrarCaixasPorLoja(event.target.value));
    }

    if (btnMarcarLoja) {
        btnMarcarLoja.addEventListener('click', selecionarTodosCaixasLojaAtual);
    }

    if (btnLimparSelecao) {
        btnLimparSelecao.addEventListener('click', limparSelecaoCaixasExclusao);
    }

    if (btnExcluirSelecionados) {
        btnExcluirSelecionados.addEventListener('click', excluirCaixasSelecionados);
    }

    document.getElementById('btn-novo').addEventListener('click', resetFormulario);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const payload = {
            tipo: document.getElementById('tipo').value,
            nome: document.getElementById('nome').value.trim(),
            ip: document.getElementById('ip').value.trim(),
            observacao: document.getElementById('obs').value.trim(),
            loja_id: document.getElementById('loja_id').value
        };

        let url = '';
        let method = 'POST';

        if (!modoEdicao) {
            url = payload.tipo === 'loja' ? '/api/cadastro/loja' : '/api/cadastro/caixa';
        } else {
            method = 'PUT';
            if (tipoEdicao === 'loja') {
                url = `/api/cadastro/loja/${idEdicao}`;
            } else {
                url = `/api/cadastro/caixa/${idEdicao}`;
            }
        }

        try {
            const response = await fetch(url, {
                method,
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                mostrarMensagem(data.erro || 'Erro ao salvar.', 'erro');
                return;
            }

            mostrarMensagem(data.mensagem || 'Registro salvo com sucesso.', 'ok');
            await carregarLojasCadastradas();
            await carregarCaixasCadastrados();
            resetFormulario();
        } catch (error) {
            console.error(error);
            mostrarMensagem('Falha de comunicação com o servidor.', 'erro');
        }
    });
});

// Importar caixas_config.json
function inicializarImportacaoConfig() {
    const inputArquivo = document.getElementById("arquivo_config_json");
    const btnImportar = document.getElementById("btn-importar-config");
    const resultado = document.getElementById("resultado-importacao-config");
    const preview = document.getElementById("preview-importacao-config");
    const checkTodos = document.getElementById("check_todos_caixas_importacao");
    const listaCaixas = document.getElementById("lista_caixas_importacao");
    const contadorCaixas = document.getElementById("contador_caixas_importacao");

    let configJsonSelecionado = null;

    function mostrarResultado(mensagem, tipo) {
        if (!resultado) {
            alert(mensagem);
            return;
        }

        resultado.textContent = mensagem;
        resultado.className = "config-import-result " + (tipo || "");
    }

    function caixasSelecionadosImportacao() {
        if (!configJsonSelecionado || !Array.isArray(configJsonSelecionado.caixas)) {
            return [];
        }

        const checks = listaCaixas ? listaCaixas.querySelectorAll(".check-caixa-importacao:checked") : [];
        return Array.from(checks)
            .map((check) => Number(check.value))
            .filter((indice) => Number.isInteger(indice) && indice >= 0)
            .map((indice) => configJsonSelecionado.caixas[indice])
            .filter(Boolean);
    }

    function atualizarContadorImportacao() {
        if (!contadorCaixas || !configJsonSelecionado || !Array.isArray(configJsonSelecionado.caixas)) {
            return;
        }

        const total = configJsonSelecionado.caixas.length;
        const selecionados = caixasSelecionadosImportacao().length;
        contadorCaixas.textContent = `${selecionados} de ${total} caixas selecionados`;

        if (checkTodos) {
            checkTodos.checked = total > 0 && selecionados === total;
            checkTodos.indeterminate = selecionados > 0 && selecionados < total;
        }
    }

    function limparPreviewImportacao() {
        configJsonSelecionado = null;

        if (preview) {
            preview.style.display = "none";
        }

        if (listaCaixas) {
            listaCaixas.innerHTML = "";
        }

        if (contadorCaixas) {
            contadorCaixas.textContent = "";
        }

        if (checkTodos) {
            checkTodos.checked = true;
            checkTodos.indeterminate = false;
        }
    }

    function renderizarPreviewImportacao() {
        if (!preview || !listaCaixas || !configJsonSelecionado) {
            return;
        }

        const caixas = Array.isArray(configJsonSelecionado.caixas) ? configJsonSelecionado.caixas : [];

        if (caixas.length === 0) {
            listaCaixas.innerHTML = '<div class="monitor-desc">Nenhum caixa encontrado no arquivo.</div>';
            preview.style.display = "block";
            atualizarContadorImportacao();
            return;
        }

        listaCaixas.innerHTML = caixas.map((caixa, indice) => {
            const nome = escaparHtml(caixa.nome || `Caixa ${indice + 1}`);
            const ip = escaparHtml(caixa.ip || "");
            const obs = escaparHtml(caixa.observacao || "");

            return `
                <label class="config-import-checkitem">
                    <input class="check-caixa-importacao" type="checkbox" value="${indice}" checked>
                    <span><strong>${nome}</strong> <small>${ip}${obs ? " - " + obs : ""}</small></span>
                </label>
            `;
        }).join("");

        listaCaixas.querySelectorAll(".check-caixa-importacao").forEach((check) => {
            check.addEventListener("change", atualizarContadorImportacao);
        });

        preview.style.display = "block";
        atualizarContadorImportacao();
    }

    if (!inputArquivo || !btnImportar) {
        console.warn("Importação JSON: campo de arquivo ou botão não encontrado.");
        return;
    }

    inputArquivo.addEventListener("change", async function () {
        limparPreviewImportacao();

        if (!inputArquivo.files || inputArquivo.files.length === 0) {
            return;
        }

        const arquivo = inputArquivo.files[0];

        if (!arquivo.name.toLowerCase().endsWith(".json")) {
            mostrarResultado("Arquivo inválido. Selecione apenas arquivo .json.", "erro");
            return;
        }

        try {
            const texto = await arquivo.text();
            const dados = JSON.parse(texto);

            if (!Array.isArray(dados.caixas)) {
                mostrarResultado("Arquivo inválido. O campo caixas precisa ser uma lista.", "erro");
                return;
            }

            configJsonSelecionado = dados;
            mostrarResultado("Marque os caixas que deseja importar e clique em Importar configurações.", "info");
            renderizarPreviewImportacao();
        } catch (erro) {
            console.error(erro);
            mostrarResultado("Não foi possível ler o JSON selecionado.", "erro");
        }
    });

    if (checkTodos) {
        checkTodos.addEventListener("change", function () {
            if (!listaCaixas) {
                return;
            }

            listaCaixas.querySelectorAll(".check-caixa-importacao").forEach((check) => {
                check.checked = checkTodos.checked;
            });

            atualizarContadorImportacao();
        });
    }

    btnImportar.addEventListener("click", async function (event) {
        event.preventDefault();

        if (!inputArquivo.files || inputArquivo.files.length === 0) {
            mostrarResultado("Selecione um arquivo caixas_config.json antes de importar.", "erro");
            return;
        }

        const arquivo = inputArquivo.files[0];

        if (!arquivo.name.toLowerCase().endsWith(".json")) {
            mostrarResultado("Arquivo inválido. Selecione apenas arquivo .json.", "erro");
            return;
        }

        if (!configJsonSelecionado) {
            mostrarResultado("Aguarde a leitura do arquivo ou selecione o JSON novamente.", "erro");
            return;
        }

        const caixasSelecionados = caixasSelecionadosImportacao();

        if (caixasSelecionados.length === 0) {
            mostrarResultado("Selecione pelo menos um caixa para importar.", "erro");
            return;
        }

        const dadosParaEnviar = {
            ...configJsonSelecionado,
            caixas: caixasSelecionados
        };

        const blob = new Blob([JSON.stringify(dadosParaEnviar)], { type: "application/json" });
        const formData = new FormData();
        formData.append("arquivo", blob, arquivo.name);

        const textoOriginal = btnImportar.textContent;
        btnImportar.disabled = true;
        btnImportar.textContent = "Importando...";
        mostrarResultado("Importando caixas selecionados...", "info");

        try {
            const response = await fetch("/api/cadastro/importar-config", {
                method: "POST",
                body: formData,
                credentials: "same-origin"
            });

            const dados = await response.json().catch(function () {
                return {};
            });

            if (!response.ok || !dados.sucesso) {
                const msgErro = dados.mensagem || dados.erro || "Erro ao importar o arquivo.";
                mostrarResultado(msgErro, "erro");
                return;
            }

            const mensagem =
                "Importação concluída. Loja: " + dados.loja +
                " | Selecionados: " + caixasSelecionados.length +
                " | Importados: " + dados.caixas_importados +
                " | Atualizados: " + dados.caixas_atualizados +
                " | Ignorados: " + dados.caixas_ignorados;

            mostrarResultado(mensagem, "sucesso");

            setTimeout(function () {
                window.location.reload();
            }, 1000);
        } catch (erro) {
            console.error(erro);
            mostrarResultado("Falha ao enviar o arquivo para o servidor.", "erro");
        } finally {
            btnImportar.disabled = false;
            btnImportar.textContent = textoOriginal;
        }
    });
}

document.addEventListener("DOMContentLoaded", inicializarImportacaoConfig);


// Exportar caixas_config.json por loja
function inicializarExportacaoConfig() {
    const selectLoja = document.getElementById("select_loja_export_config");
    const btnExportar = document.getElementById("btn-exportar-config");

    if (!selectLoja || !btnExportar) {
        return;
    }

    btnExportar.addEventListener("click", function (event) {
        event.preventDefault();

        const lojaId = selectLoja.value;

        if (!lojaId) {
            alert("Selecione uma loja para exportar.");
            selectLoja.focus();
            return;
        }

        // Rota existente no Flask para baixar o JSON.
        window.location.href = `/api/cadastro/exportar-config/${encodeURIComponent(lojaId)}`;
    });
}

document.addEventListener("DOMContentLoaded", inicializarExportacaoConfig);
