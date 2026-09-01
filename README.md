projeto dashboard web estrutura:

Front-end

Foi desenvolvido principalmente com:
- HTML5.
- CSS próprio.
- JavaScript puro, sem React, Angular ou Vue.
- Templates Jinja2, renderizados pelo Flask.
- Font Awesome para alguns ícones.
Principais pastas:
- [templates](C:/dashboard_monitor/templates): páginas HTML, como login, usuários, cadastros e monitoramentos.
- [static](C:/dashboard_monitor/static): arquivos JavaScript, CSS e recursos visuais.
O JavaScript chama o backend usando fetch(), por exemplo para cadastrar, alterar, excluir e consultar informações.

Back-end

Foi desenvolvido em Python, principalmente com:
- Flask: rotas, login, sessões, APIs e renderização das páginas.
- Werkzeug: hashes scrypt das senhas, segurança de autenticação e utilitários.
- Cheroot: servidor HTTPS usado para executar o dashboard.
- Cryptography: criação e proteção dos certificados HTTPS.
- PyWin32/DPAPI: criptografia das credenciais no Windows.
- MySQL Connector: comunicação com o MySQL.
- Threads: execução paralela das verificações das lojas e equipamentos.
Arquivos principais:
- [app.py](C:/dashboard_monitor/app.py): aplicação principal, APIs, autenticação, cadastros e monitoramento.
- [database.py](C:/dashboard_monitor/database.py): conexão e operações no MySQL.
- [https_launcher.py](C:/dashboard_monitor/https_launcher.py): inicia o servidor HTTPS.
- [tls_certificate.py](C:/dashboard_monitor/tls_certificate.py): gera e carrega os certificados.
- [secret_store.py](C:/dashboard_monitor/secret_store.py): protege credenciais com DPAPI.

Banco de dados

O projeto utiliza MySQL para armazenar:
- Lojas.
- Caixas e equipamentos.
- Usuários.
- Hashes das senhas.
- Permissões.
- Informações de auditoria.
As senhas não são descriptografadas: o sistema compara a senha digitada com o hash scrypt armazenado no MySQL.

Fluxo simplificado

Navegador
   ↓ HTTPS
HTML/CSS/JavaScript
   ↓ requisições fetch e formulários
Flask / app.py
   ↓
database.py
   ↓ conexão TLS
MySQL


