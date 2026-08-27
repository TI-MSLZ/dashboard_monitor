(() => {
    const form = document.querySelector("#form-usuario");
    const idInput = document.querySelector("#usuario-id");
    const nomeInput = document.querySelector("#nome");
    const loginInput = document.querySelector("#login-usuario");
    const senhaInput = document.querySelector("#senha");
    const adminInput = document.querySelector("#administrador");
    const ativoInput = document.querySelector("#ativo");
    const mensagem = document.querySelector("#mensagem");
    const titulo = document.querySelector("#form-titulo");
    const btnSalvar = document.querySelector("#btn-salvar");
    const btnCancelar = document.querySelector("#btn-cancelar");
    const senhaDica = document.querySelector("#senha-dica");
    const permissoes = [...document.querySelectorAll('[name="permissoes"]')];

    function avisar(texto, tipo = "erro") {
        mensagem.textContent = texto;
        mensagem.className = `usuario-mensagem ${tipo}`;
        mensagem.hidden = false;
    }

    function limparForm() {
        form.reset();
        idInput.value = "";
        ativoInput.checked = true;
        loginInput.disabled = false;
        senhaInput.required = true;
        senhaDica.textContent = "(12+ caracteres com maiúscula, minúscula, número e símbolo)";
        titulo.textContent = "Cadastrar novo usuário";
        btnSalvar.querySelector("span").textContent = "Cadastrar usuário";
        btnSalvar.querySelector("i").className = "fa-solid fa-user-plus";
        btnCancelar.hidden = true;
        mensagem.hidden = true;
        document.querySelector(".permissoes-fieldset").classList.remove("desabilitado");
    }

    async function enviar(url, options) {
        const resposta = await fetch(url, options);
        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok) throw new Error(dados.mensagem || "Não foi possível concluir a operação.");
        return dados;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const editando = Boolean(idInput.value);
        const payload = {
            nome: nomeInput.value.trim(),
            usuario: loginInput.value.trim().toLowerCase(),
            senha: senhaInput.value,
            administrador: adminInput.checked,
            ativo: ativoInput.checked,
            permissoes: permissoes.filter(item => item.checked).map(item => item.value),
        };
        btnSalvar.disabled = true;
        try {
            const dados = await enviar(editando ? `/api/usuarios/${idInput.value}` : "/api/usuarios", {
                method: editando ? "PUT" : "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload),
            });
            avisar(dados.mensagem, "sucesso");
            setTimeout(() => window.location.reload(), 650);
        } catch (erro) {
            avisar(erro.message);
            btnSalvar.disabled = false;
        }
    });

    document.querySelectorAll(".editar-usuario").forEach(botao => {
        botao.addEventListener("click", () => {
            const item = JSON.parse(botao.dataset.user);
            idInput.value = item.id;
            nomeInput.value = item.nome;
            loginInput.value = item.usuario;
            loginInput.disabled = false;
            senhaInput.value = "";
            senhaInput.required = false;
            senhaDica.textContent = "(deixe vazia para manter a atual)";
            adminInput.checked = item.administrador;
            ativoInput.checked = item.ativo;
            permissoes.forEach(campo => campo.checked = item.permissoes.includes(campo.value));
            document.querySelector(".permissoes-fieldset").classList.toggle("desabilitado", item.administrador);
            titulo.textContent = `Editar usuário: ${item.usuario}`;
            btnSalvar.querySelector("span").textContent = "Salvar alterações";
            btnSalvar.querySelector("i").className = "fa-solid fa-floppy-disk";
            btnCancelar.hidden = false;
            mensagem.hidden = true;
            window.scrollTo({top: 0, behavior: "smooth"});
        });
    });

    document.querySelectorAll(".excluir-usuario").forEach(botao => {
        botao.addEventListener("click", async () => {
            if (!confirm(`Excluir o usuário @${botao.dataset.login}?`)) return;
            try {
                await enviar(`/api/usuarios/${botao.dataset.id}`, {method: "DELETE"});
                window.location.reload();
            } catch (erro) {
                avisar(erro.message);
                window.scrollTo({top: 0, behavior: "smooth"});
            }
        });
    });

    document.querySelector("#selecionar-todas").addEventListener("click", event => {
        const marcar = permissoes.some(item => !item.checked);
        permissoes.forEach(item => item.checked = marcar);
        event.currentTarget.textContent = marcar ? "Limpar seleção" : "Selecionar todas";
    });
    adminInput.addEventListener("change", () => {
        document.querySelector(".permissoes-fieldset").classList.toggle("desabilitado", adminInput.checked);
    });
    btnCancelar.addEventListener("click", limparForm);
    document.querySelector("#mostrar-senha").addEventListener("click", event => {
        senhaInput.type = senhaInput.type === "password" ? "text" : "password";
        event.currentTarget.querySelector("i").className = senhaInput.type === "password" ? "fa-regular fa-eye" : "fa-regular fa-eye-slash";
    });
})();
