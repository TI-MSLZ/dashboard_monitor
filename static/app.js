let graficoRede = null;
let carregandoDashboard = false;
let lojasDashboard = [];
let lojaSelecionadaChave = "";
let intervaloProgressoDashboard = null;

const INTERVALO_DASHBOARD_MS = 30000;

const dashboardCenterText = {
    id: 'dashboardCenterText',
    afterDraw(chart) {
        const total = chart.data.datasets[0].data.reduce((acc, item) => acc + Number(item || 0), 0);
        const online = Number(chart.data.datasets[0].data[0] || 0);
        const percentual = total ? Math.round((online / total) * 100) : 0;
        const { ctx, chartArea } = chart;

        if (!chartArea) return;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 34px Arial';
        ctx.fillText(`${percentual}%`, (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 - 8);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '600 12px Arial';
        ctx.fillText('rede online', (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 + 22);
        ctx.restore();
    }
};

function escaparHtml(valor) {
    return (valor ?? "-").toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function escaparAtributo(valor) {
    return escaparHtml(valor).replaceAll('`', '&#096;');
}

function normalizarStatus(valor) {
    return (valor || '-').toString().trim().toLowerCase();
}

function chaveLoja(loja) {
    return `${loja?.nome || ''}|${loja?.ip || ''}`;
}

function lojaEstaOnline(loja) {
    return normalizarStatus(loja?.rede) === 'online' && normalizarStatus(loja?.terminal) === 'online';
}

function textoSituacaoLoja(loja) {
    const redeOnline = normalizarStatus(loja?.rede) === 'online';
    const terminalOnline = normalizarStatus(loja?.terminal) === 'online';

    if (redeOnline && terminalOnline) return 'Tudo online';
    if (!redeOnline && !terminalOnline) return 'Rede e terminal offline';
    if (!redeOnline) return 'Rede offline';
    return 'Terminal offline';
}

function criarBadgeStatus(valor) {
    const texto = normalizarStatus(valor);
    const classe = texto === 'online' ? 'badge badge-online' : 'badge badge-offline';
    return `<span class="${classe}"><span class="badge-dot"></span>${escaparHtml(texto).toUpperCase()}</span>`;
}

function dividirLojas(lojas) {
    const meio = Math.ceil(lojas.length / 2);
    return {
        coluna1: lojas.slice(0, meio),
        coluna2: lojas.slice(meio)
    };
}

function filtrarLojas(lojas) {
    const termo = (document.getElementById('filtro_lojas')?.value || '').trim().toLowerCase();
    const status = document.getElementById('filtro_status')?.value || 'todos';

    return lojas.filter(loja => {
        const nome = (loja.nome || '').toLowerCase();
        const ip = (loja.ip || '').toLowerCase();
        const passaBusca = !termo || nome.includes(termo) || ip.includes(termo);

        const passaStatus =
            status === 'todos' ||
            (status === 'rede_offline' && loja.rede !== 'online') ||
            (status === 'terminal_offline' && loja.terminal !== 'online') ||
            (status === 'online' && loja.rede === 'online' && loja.terminal === 'online');

        return passaBusca && passaStatus;
    });
}

function montarTabela(lojas) {
    if (!lojas || lojas.length === 0) {
        return `
            <tr>
                <td colspan="4" class="empty-row">Nenhuma loja encontrada.</td>
            </tr>
        `;
    }

    return lojas.map(loja => {
        const alerta = lojaEstaOnline(loja) ? 'linha-ok' : 'linha-alerta';
        const selecionada = chaveLoja(loja) === lojaSelecionadaChave ? 'store-row-selected' : '';
        const dotClass = lojaEstaOnline(loja) ? 'state-ok' : 'state-alert';
        const key = escaparAtributo(chaveLoja(loja));
        const ip = loja.ip ?? '-';

        return `
            <tr class="store-row ${alerta} ${selecionada}" data-store-key="${key}" title="Clique para ver detalhes">
                <td>
                    <button class="store-name-button" type="button">
                        <span class="store-state-dot ${dotClass}"></span>
                        <span>
                            <strong>${escaparHtml(loja.nome ?? '-')}</strong>
                            <small>${escaparHtml(textoSituacaoLoja(loja))}</small>
                        </span>
                    </button>
                </td>
                <td>
                    <button class="ip-copy" type="button" data-copy-ip="${escaparAtributo(ip)}" title="Copiar IP">
                        <span>${escaparHtml(ip)}</span>
                        <i class="fa-regular fa-copy"></i>
                    </button>
                </td>
                <td>${criarBadgeStatus(loja.rede)}</td>
                <td>${criarBadgeStatus(loja.terminal)}</td>
            </tr>
        `;
    }).join('');
}

function atualizarFiltroRapidoAtivo() {
    const status = document.getElementById('filtro_status')?.value || 'todos';

    document.querySelectorAll('[data-dashboard-filter]').forEach(botao => {
        botao.classList.toggle('active', botao.dataset.dashboardFilter === status);
    });
}

function atualizarContadorLojas(lojasFiltradas) {
    const contador = document.getElementById('contador_lojas_filtradas');
    if (!contador) return;

    const total = lojasDashboard.length;
    const exibidas = lojasFiltradas.length;
    contador.textContent = total === exibidas ? `${total} lojas` : `${exibidas} de ${total} lojas`;
}

function atualizarTabelaFiltrada() {
    const lojasFiltradas = filtrarLojas(lojasDashboard);
    const { coluna1, coluna2 } = dividirLojas(lojasFiltradas);

    const tabela1 = document.getElementById('tabela_lojas_coluna_1');
    const tabela2 = document.getElementById('tabela_lojas_coluna_2');

    if (tabela1) tabela1.innerHTML = montarTabela(coluna1);
    if (tabela2) tabela2.innerHTML = montarTabela(coluna2);

    atualizarFiltroRapidoAtivo();
    atualizarContadorLojas(lojasFiltradas);
}

function atualizarResumo(data) {
    const redePercentual = Number(data.rede_percentual || 0);
    const terminalPercentual = Number(data.terminal_percentual || 0);

    const resumoRede = document.getElementById('resumo_rede');
    const resumoTerminal = document.getElementById('resumo_terminal');
    const barraRede = document.getElementById('barra_rede_online');
    const barraTerminal = document.getElementById('barra_terminal_online');

    if (resumoRede) resumoRede.innerHTML = `<i class="fa-solid fa-network-wired"></i> Rede: <strong>${redePercentual}%</strong> online`;
    if (resumoTerminal) resumoTerminal.innerHTML = `<i class="fa-solid fa-desktop"></i> Terminal: <strong>${terminalPercentual}%</strong> online`;
    if (barraRede) barraRede.style.width = `${redePercentual}%`;
    if (barraTerminal) barraTerminal.style.width = `${terminalPercentual}%`;
}

function atualizarGrafico(redeOnline, redeOffline) {
    const canvas = document.getElementById('graficoRede');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (graficoRede) {
        graficoRede.destroy();
    }

    graficoRede = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Online', 'Offline'],
            datasets: [{
                data: [redeOnline || 0, redeOffline || 0],
                backgroundColor: ['#22c55e', '#fb7185'],
                hoverBackgroundColor: ['#4ade80', '#fda4af'],
                borderColor: ['rgba(34, 197, 94, 0.22)', 'rgba(251, 113, 133, 0.25)'],
                borderWidth: 2,
                spacing: 4,
                borderRadius: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 520, easing: 'easeOutQuart' },
            cutout: '68%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#dbeafe',
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 18
                    }
                },
                tooltip: {
                    callbacks: {
                        label(context) {
                            const total = context.dataset.data.reduce((acc, item) => acc + Number(item || 0), 0);
                            const valor = Number(context.raw || 0);
                            const percentual = total ? Math.round((valor / total) * 100) : 0;
                            return `${context.label}: ${valor} (${percentual}%)`;
                        }
                    }
                }
            }
        },
        plugins: [dashboardCenterText]
    });
}

function mostrarErro() {
    const linhaErro = `
        <tr>
            <td colspan="4" class="empty-row">Erro ao carregar os dados.</td>
        </tr>
    `;

    const coluna1 = document.getElementById('tabela_lojas_coluna_1');
    const coluna2 = document.getElementById('tabela_lojas_coluna_2');
    const ultima = document.getElementById('ultima_verificacao');

    if (coluna1) coluna1.innerHTML = linhaErro;
    if (coluna2) coluna2.innerHTML = linhaErro;
    if (ultima) ultima.textContent = 'Erro ao carregar';
}

function encontrarLojaPorChave(chave) {
    return lojasDashboard.find(loja => chaveLoja(loja) === chave) || null;
}

function atualizarPainelDetalhe(loja) {
    const painel = document.getElementById('painel_detalhe_loja');
    if (!painel || !loja) return;

    painel.hidden = false;

    const nome = document.getElementById('detalhe_loja_nome');
    const ip = document.getElementById('detalhe_loja_ip');
    const rede = document.getElementById('detalhe_loja_rede');
    const terminal = document.getElementById('detalhe_loja_terminal');
    const copiar = document.getElementById('btn_copiar_ip_detalhe');

    if (nome) nome.textContent = loja.nome || '-';
    if (ip) ip.textContent = `IP ${loja.ip || '-'}`;
    if (rede) rede.innerHTML = criarBadgeStatus(loja.rede);
    if (terminal) terminal.innerHTML = criarBadgeStatus(loja.terminal);
    if (copiar) copiar.dataset.copyIp = loja.ip || '';
}

function selecionarLoja(chave) {
    const loja = encontrarLojaPorChave(chave);
    if (!loja) return;

    lojaSelecionadaChave = chave;
    atualizarPainelDetalhe(loja);
    atualizarTabelaFiltrada();
}

function escolherLojaInicial() {
    if (!lojasDashboard.length) return;

    const lojaAtual = encontrarLojaPorChave(lojaSelecionadaChave);
    const loja = lojaAtual || lojasDashboard.find(item => !lojaEstaOnline(item)) || lojasDashboard[0];

    lojaSelecionadaChave = chaveLoja(loja);
    atualizarPainelDetalhe(loja);
}

function mostrarToast(mensagem) {
    let toast = document.getElementById('dashboard-toast');

    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'dashboard-toast';
        toast.className = 'dashboard-toast';
        document.body.appendChild(toast);
    }

    toast.textContent = mensagem;
    toast.classList.add('show');

    window.clearTimeout(toast.dataset.timeoutId);
    const timeoutId = window.setTimeout(() => toast.classList.remove('show'), 1800);
    toast.dataset.timeoutId = timeoutId;
}

async function copiarTexto(texto) {
    if (!texto || texto === '-') {
        mostrarToast('IP indisponivel');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(texto);
        } else {
            const area = document.createElement('textarea');
            area.value = texto;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.left = '-9999px';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
        }

        mostrarToast(`IP ${texto} copiado`);
    } catch (error) {
        console.error('Falha ao copiar IP:', error);
        mostrarToast('Nao foi possivel copiar');
    }
}

function configurarInteracoesTabela() {
    const secao = document.getElementById('status-lojas');
    if (!secao) return;

    secao.addEventListener('click', async (event) => {
        const botaoCopiar = event.target.closest('[data-copy-ip]');

        if (botaoCopiar) {
            event.preventDefault();
            event.stopPropagation();
            await copiarTexto(botaoCopiar.dataset.copyIp || '');
            return;
        }

        const linha = event.target.closest('tr[data-store-key]');
        if (linha) {
            selecionarLoja(linha.dataset.storeKey);
        }
    });
}

function configurarFiltros() {
    const inputBusca = document.getElementById('filtro_lojas');
    const selectStatus = document.getElementById('filtro_status');

    inputBusca?.addEventListener('input', atualizarTabelaFiltrada);
    selectStatus?.addEventListener('change', atualizarTabelaFiltrada);

    document.querySelectorAll('[data-dashboard-filter]').forEach(botao => {
        botao.addEventListener('click', () => {
            if (selectStatus) {
                selectStatus.value = botao.dataset.dashboardFilter || 'todos';
            }

            atualizarTabelaFiltrada();
        });
    });
}

function reiniciarProgressoAtualizacao() {
    const progress = document.getElementById('dashboard_refresh_progress');
    const timer = document.getElementById('dashboard_refresh_timer');

    if (progress) progress.style.width = '0%';
    if (timer) timer.textContent = `${Math.round(INTERVALO_DASHBOARD_MS / 1000)}s`;

    const inicio = Date.now();

    window.clearInterval(intervaloProgressoDashboard);
    intervaloProgressoDashboard = window.setInterval(() => {
        const decorrido = Date.now() - inicio;
        const percentual = Math.min(100, Math.round((decorrido / INTERVALO_DASHBOARD_MS) * 100));
        const restante = Math.max(0, Math.ceil((INTERVALO_DASHBOARD_MS - decorrido) / 1000));

        if (progress) progress.style.width = `${percentual}%`;
        if (timer) timer.textContent = `${restante}s`;
    }, 500);
}

async function carregarDashboard() {
    if (carregandoDashboard) return;
    carregandoDashboard = true;

    const botaoAtualizar = document.getElementById('btn_atualizar_dashboard');
    botaoAtualizar?.classList.add('is-loading');
    if (botaoAtualizar) botaoAtualizar.disabled = true;

    try {
        const response = await fetch('/api/dashboard', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' }
        });

        if (response.redirected) {
            window.location.href = response.url;
            return;
        }

        if (response.status === 401 || response.status === 403) {
            window.location.href = '/login';
            return;
        }

        if (!response.ok) {
            throw new Error(`Erro HTTP ${response.status}`);
        }

        const data = await response.json();

        document.getElementById('ultima_verificacao').textContent = data.ultima_verificacao ?? '-';
        document.getElementById('total_lojas').textContent = data.total_lojas ?? 0;
        document.getElementById('rede_online').textContent = data.rede_online ?? 0;
        document.getElementById('rede_offline').textContent = data.rede_offline ?? 0;
        document.getElementById('terminal_online').textContent = data.terminal_online ?? 0;
        document.getElementById('terminal_offline').textContent = data.terminal_offline ?? 0;

        lojasDashboard = Array.isArray(data.lojas) ? data.lojas : [];
        escolherLojaInicial();
        atualizarTabelaFiltrada();
        atualizarResumo(data);
        atualizarGrafico(data.rede_online, data.rede_offline);
    } catch (error) {
        console.error('Falha ao carregar dashboard:', error);
        mostrarErro();
    } finally {
        carregandoDashboard = false;
        botaoAtualizar?.classList.remove('is-loading');
        if (botaoAtualizar) botaoAtualizar.disabled = false;
        reiniciarProgressoAtualizacao();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    configurarFiltros();
    configurarInteracoesTabela();

    document.getElementById('btn_atualizar_dashboard')?.addEventListener('click', carregarDashboard);
    document.getElementById('btn_copiar_ip_detalhe')?.addEventListener('click', (event) => {
        copiarTexto(event.currentTarget.dataset.copyIp || '');
    });

    carregarDashboard();
    window.setInterval(carregarDashboard, INTERVALO_DASHBOARD_MS);
});
