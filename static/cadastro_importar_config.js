// Importação de caixas_config.json
// Inclua este arquivo na página cadastro.html OU copie este código para o JS atual do cadastro.

document.addEventListener("DOMContentLoaded", function () {
    const inputArquivo = document.querySelector(
        '#arquivoConfig, #fileInput, #inputImportarConfig, input[type="file"][accept=".json"], input[type="file"]'
    );

    const botaoImportar = document.querySelector(
        '#btnImportarConfig, #btnImportar, button[data-action="importar-config"]'
    );

    if (!inputArquivo || !botaoImportar) {
        console.warn("Importação JSON: input ou botão não encontrado.");
        return;
    }

    botaoImportar.addEventListener("click", async function (event) {
        event.preventDefault();

        if (!inputArquivo.files || inputArquivo.files.length === 0) {
            alert("Selecione um arquivo caixas_config.json antes de importar.");
            return;
        }

        const arquivo = inputArquivo.files[0];

        if (!arquivo.name.toLowerCase().endsWith(".json")) {
            alert("Selecione apenas arquivo .json.");
            return;
        }

        const formData = new FormData();
        formData.append("arquivo", arquivo);
        const csrfCookie = document.cookie.split("; ").find(item => item.startsWith("XSRF-TOKEN="));
        const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice("XSRF-TOKEN=".length)) : "";

        botaoImportar.disabled = true;
        const textoOriginal = botaoImportar.textContent;
        botaoImportar.textContent = "Importando...";

        try {
            const resposta = await fetch("/api/cadastro/importar-config", {
                method: "POST",
                body: formData,
                credentials: "same-origin",
                headers: {"X-CSRF-Token": csrfToken}
            });

            const dados = await resposta.json().catch(() => ({}));

            if (!resposta.ok || !dados.sucesso) {
                alert(dados.mensagem || dados.erro || "Erro ao importar o arquivo.");
                return;
            }

            alert(
                `${dados.mensagem}\n\n` +
                `Loja: ${dados.loja}\n` +
                `Caixas importados: ${dados.caixas_importados}\n` +
                `Caixas atualizados: ${dados.caixas_atualizados}\n` +
                `Caixas ignorados: ${dados.caixas_ignorados}`
            );

            window.location.reload();
        } catch (erro) {
            console.error(erro);
            alert("Falha ao enviar o arquivo para o servidor.");
        } finally {
            botaoImportar.disabled = false;
            botaoImportar.textContent = textoOriginal;
        }
    });
});
