(() => {
    "use strict";

    const seletor = document.querySelector("#config-loja");
    const form = document.querySelector("#config-agente-form");
    const status = document.querySelector("#config-status");
    const pareamento = document.querySelector("#pareamento-box");
    const chave = document.querySelector("#config-chave");

    const campo = nome => form.elements.namedItem(nome);

    function mensagem(texto, tipo = "info") {
        status.textContent = texto;
        status.className = `config-agente-status ${tipo}`;
        status.hidden = false;
    }

    async function requisicao(url, opcoes = {}) {
        const resposta = await fetch(url, opcoes);
        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok) {
            throw new Error(dados.mensagem || "Não foi possível concluir a operação.");
        }
        return dados;
    }

    function preencher(dados, aviso = "", tipoAviso = "") {
        const sql = dados.configuracao.banco_syspdv;
        const fb = dados.configuracao.firebird_caixas;
        campo("sql_servidor").value = sql.servidor;
        campo("sql_porta").value = sql.porta;
        campo("sql_banco").value = sql.banco;
        campo("sql_usuario").value = sql.usuario;
        campo("sql_senha").value = "";
        campo("sql_driver").value = sql.driver;
        campo("sql_timeout").value = sql.timeout_segundos;
        campo("sql_limite").value = sql.limite_registros;
        campo("sql_windows").checked = Boolean(sql.autenticacao_windows);
        campo("fb_porta").value = fb.porta;
        campo("fb_banco").value = fb.banco;
        campo("fb_usuario").value = fb.usuario;
        campo("fb_senha").value = "";
        campo("fb_charset").value = fb.charset;
        campo("fb_timeout").value = fb.timeout_segundos;
        document.querySelector("#sql-senha-dica").textContent = dados.senhas_configuradas.sql_server ? "Deixe vazia para manter a senha atual." : "Informe a senha.";
        document.querySelector("#fb-senha-dica").textContent = dados.senhas_configuradas.firebird ? "Deixe vazia para manter a senha atual." : "Informe a senha.";
        form.hidden = false;
        pareamento.hidden = true;
        const partes = [];
        if (aviso) partes.push(aviso);
        partes.push(dados.configurado ? `Versão ${dados.versao} salva no MySQL` : "Ainda não configurado");
        if (dados.alterado_em) {
            partes.push(`alterada em ${dados.alterado_em}${dados.alterado_por ? ` por ${dados.alterado_por}` : ""}`);
        }
        if (dados.sincronizado_em) partes.push(`sincronizado em ${dados.sincronizado_em}`);
        if (dados.ultimo_erro) partes.push(`última falha: ${dados.ultimo_erro}`);
        mensagem(partes.join(" • "), tipoAviso || (dados.ultimo_erro ? "alerta" : "sucesso"));
    }

    async function consultarSalvo(aviso = "", tipoAviso = "") {
        if (!seletor.value) throw new Error("Selecione uma loja.");
        const dados = await requisicao(`/api/cadastro/configuracoes-agentes/${seletor.value}`);
        preencher(dados, aviso, tipoAviso);
        return dados;
    }

    function payload() {
        return {configuracao: {
            banco_syspdv: {
                servidor: campo("sql_servidor").value.trim(),
                porta: Number(campo("sql_porta").value),
                banco: campo("sql_banco").value.trim(),
                usuario: campo("sql_usuario").value.trim(),
                senha: campo("sql_senha").value,
                autenticacao_windows: campo("sql_windows").checked,
                driver: campo("sql_driver").value.trim(),
                timeout_segundos: Number(campo("sql_timeout").value),
                limite_registros: Number(campo("sql_limite").value),
            },
            firebird_caixas: {
                porta: Number(campo("fb_porta").value),
                banco: campo("fb_banco").value.trim(),
                usuario: campo("fb_usuario").value.trim(),
                senha: campo("fb_senha").value,
                charset: campo("fb_charset").value.trim(),
                timeout_segundos: Number(campo("fb_timeout").value),
            },
        }};
    }

    seletor.addEventListener("change", async () => {
        form.hidden = true;
        pareamento.hidden = true;
        if (!seletor.value) {
            status.hidden = true;
            return;
        }
        mensagem("Carregando configuração…");
        try {
            await consultarSalvo();
        } catch (erro) {
            mensagem(erro.message, "erro");
        }
    });

    form.addEventListener("submit", async event => {
        event.preventDefault();
        const botao = document.querySelector("#config-salvar");
        botao.disabled = true;
        mensagem("Cifrando, salvando e sincronizando…");
        try {
            const dados = await requisicao(`/api/cadastro/configuracoes-agentes/${seletor.value}`, {
                method: "PUT",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload()),
            });
            const aviso = dados.mensagem +
                (dados.erro_sincronizacao ? ` ${dados.erro_sincronizacao}` : "") +
                " Dados recarregados diretamente do MySQL.";
            await consultarSalvo(aviso, dados.sincronizado ? "sucesso" : "alerta");
        } catch (erro) {
            mensagem(erro.message, "erro");
        } finally {
            botao.disabled = false;
        }
    });

    document.querySelector("#config-consultar").addEventListener("click", async event => {
        const botao = event.currentTarget;
        botao.disabled = true;
        mensagem("Consultando os dados salvos no MySQL…");
        try {
            await consultarSalvo("Consulta concluída diretamente no MySQL.");
        } catch (erro) {
            mensagem(erro.message, "erro");
        } finally {
            botao.disabled = false;
        }
    });

    document.querySelector("#config-testar").addEventListener("click", async event => {
        if (!form.reportValidity()) return;
        const botao = event.currentTarget;
        botao.disabled = true;
        mensagem("Testando SQL Server e Firebird pelo agente, sem salvar…");
        try {
            const dados = await requisicao(`/api/cadastro/configuracoes-agentes/${seletor.value}/testar`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload()),
            });
            const sql = dados.sql_server || {};
            const fb = dados.firebird || {};
            const textoSql = sql.sucesso
                ? `SQL Server conectado (${Number(sql.ips_descobertos || 0)} IP(s) encontrado(s))`
                : `SQL Server falhou: ${sql.erro || "erro não informado"}`;
            let textoFb;
            if (fb.sucesso) {
                textoFb = `Firebird conectado em ${Number(fb.conexoes_ok || 0)} caixa(s)`;
            } else if (fb.testado === false) {
                textoFb = `Firebird não testado: ${fb.erro || "nenhum IP de caixa encontrado"}`;
            } else {
                textoFb = `Firebird: ${Number(fb.conexoes_ok || 0)} conexão(ões) OK e ${Number(fb.conexoes_falha || 0)} falha(s)`;
                if (fb.erro) textoFb += ` — ${fb.erro}`;
            }
            mensagem(`${textoSql} • ${textoFb}. Nenhuma alteração foi salva.`, dados.sucesso ? "sucesso" : "alerta");
        } catch (erro) {
            mensagem(`${erro.message} Nenhuma alteração foi salva.`, "erro");
        } finally {
            botao.disabled = false;
        }
    });

    document.querySelector("#config-sincronizar").addEventListener("click", async event => {
        event.currentTarget.disabled = true;
        mensagem("Sincronizando com o agente…");
        try {
            const dados = await requisicao(`/api/cadastro/configuracoes-agentes/${seletor.value}/sincronizar`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
            mensagem(dados.mensagem, "sucesso");
        } catch (erro) {
            mensagem(erro.message, "erro");
        } finally {
            event.currentTarget.disabled = false;
        }
    });

    document.querySelector("#config-parear").addEventListener("click", async () => {
        try {
            const dados = await requisicao(`/api/cadastro/configuracoes-agentes/${seletor.value}/pareamento`);
            chave.value = dados.chave;
            chave.type = "password";
            pareamento.hidden = false;
            pareamento.scrollIntoView({behavior: "smooth", block: "nearest"});
        } catch (erro) {
            mensagem(erro.message, "erro");
        }
    });

    document.querySelector("#config-mostrar-chave").addEventListener("click", event => {
        chave.type = chave.type === "password" ? "text" : "password";
        event.currentTarget.textContent = chave.type === "password" ? "Mostrar" : "Ocultar";
    });

    document.querySelector("#config-copiar-chave").addEventListener("click", async event => {
        await navigator.clipboard.writeText(chave.value);
        event.currentTarget.textContent = "Copiada";
        setTimeout(() => { event.currentTarget.textContent = "Copiar"; }, 1200);
    });
})();
