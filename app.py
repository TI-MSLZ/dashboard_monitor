from flask import Flask, render_template, request, redirect, url_for, session, jsonify, Response, g
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix
from functools import wraps
from datetime import datetime, timedelta
from time import time
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict, deque
import subprocess
import platform
import urllib.request
import urllib.error
import json
import os
import logging
from logging.handlers import RotatingFileHandler
import re
import ipaddress
import secrets
import hmac

from secret_store import carregar_ou_criar_segredo, ler_segredo, migrar_segredo_texto

from database import (
    BASE_DIR,
    DB_BACKEND,
    DB_INTEGRITY_ERRORS,
    DB_PATH,
    coluna_existe,
    criar_schema,
    get_db,
)



def env_bool(nome, padrao=False):
    return os.getenv(nome, str(padrao)).strip().lower() in {"1", "true", "yes", "sim", "on"}


def carregar_ou_criar_chave_secreta():
    """Mantém a chave estável e criptografada pelo DPAPI do Windows."""
    if os.getenv("SECRET_KEY", ""):
        raise RuntimeError(
            "SECRET_KEY em texto simples não é aceita; use o arquivo DPAPI padrão."
        )

    caminho = os.getenv(
        "DASHBOARD_SECRET_KEY_FILE",
        os.path.join(BASE_DIR, ".secret_key.dpapi"),
    )
    antigo = os.path.join(BASE_DIR, ".secret_key")
    chave_bytes = migrar_segredo_texto(antigo, caminho, "Chave de sessão do Dashboard")
    if chave_bytes is None:
        chave_bytes = carregar_ou_criar_segredo(
            caminho, 64, "Chave de sessão do Dashboard"
        )
    chave = chave_bytes.decode("utf-8")
    if len(chave) < 32:
        raise RuntimeError("A chave de sessão persistida é inválida ou curta demais.")
    return chave


app = Flask(__name__)
app.config.update(
    SECRET_KEY=carregar_ou_criar_chave_secreta(),
    MAX_CONTENT_LENGTH=int(os.getenv("DASHBOARD_MAX_UPLOAD_BYTES", str(1024 * 1024))),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=int(os.getenv("DASHBOARD_SESSION_HOURS", "8"))),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    SESSION_COOKIE_SECURE=env_bool("DASHBOARD_HTTPS_ONLY", False),
)
hosts_confiaveis = [item.strip() for item in os.getenv("DASHBOARD_TRUSTED_HOSTS", "").split(",") if item.strip()]
if hosts_confiaveis:
    app.config["TRUSTED_HOSTS"] = hosts_confiaveis
if env_bool("DASHBOARD_BEHIND_PROXY", False):
    # Confia em exatamente um proxy. Use somente com o backend preso ao loopback.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("dashboard_monitor")
if not any(isinstance(handler, RotatingFileHandler) for handler in logger.handlers):
    os.makedirs(BASE_DIR, exist_ok=True)
    handler = RotatingFileHandler(
        os.path.join(BASE_DIR, "security_app.log"), maxBytes=2 * 1024 * 1024,
        backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(handler)

AGENTE_PORTA = int(os.getenv("AGENTE_PORTA", "5001"))
AGENTE_TIMEOUT = int(os.getenv("AGENTE_TIMEOUT", "5"))
AGENTE_TERMINAL_TIMEOUT = float(os.getenv("AGENTE_TERMINAL_TIMEOUT", "2.5"))
AGENTE_VPNTEF_PORTA = int(os.getenv("AGENTE_VPNTEF_PORTA", "5002"))
AGENTE_VPNTEF_TIMEOUT = float(os.getenv("AGENTE_VPNTEF_TIMEOUT", "3"))
AGENTE_CRM_PORTA = int(os.getenv("AGENTE_CRM_PORTA", "5003"))
AGENTE_CRM_TIMEOUT = float(os.getenv("AGENTE_CRM_TIMEOUT", "4"))

DASHBOARD_CACHE_SEGUNDOS = 30
DASHBOARD_CACHE = {"dados": None, "gerado_em": 0}
DASHBOARD_CACHE_LOCK = Lock()
DASHBOARD_REFRESH_LOCK = Lock()

TERMINAL_CACHE_SEGUNDOS = int(os.getenv("TERMINAL_CACHE_SEGUNDOS", "30"))
TERMINAL_CACHE = {}
TERMINAL_CACHE_LOCK = Lock()
TERMINAL_CACHE_IP_LOCKS = {}

CATRACAS_CACHE_PATH = os.path.join(BASE_DIR, "catracas_lojas_cache.json")
CATRACAS_CACHE_LOCK = Lock()


def carregar_cache_catracas():
    try:
        with open(CATRACAS_CACHE_PATH, "r", encoding="utf-8") as arquivo:
            dados = json.load(arquivo)
        return dados if isinstance(dados, dict) else {}
    except (OSError, ValueError):
        return {}


CATRACAS_CACHE = carregar_cache_catracas()


def salvar_situacao_catraca(ip, pasta_existe):
    """Guarda a última existência conhecida de C:\\SQS para quando o agente parar."""
    with CATRACAS_CACHE_LOCK:
        chave = str(ip)
        novo_valor = bool(pasta_existe)
        if chave in CATRACAS_CACHE and CATRACAS_CACHE[chave] == novo_valor:
            return
        CATRACAS_CACHE[chave] = novo_valor
        temporario = f"{CATRACAS_CACHE_PATH}.{os.getpid()}.tmp"
        try:
            os.makedirs(os.path.dirname(CATRACAS_CACHE_PATH) or BASE_DIR, exist_ok=True)
            with open(temporario, "w", encoding="utf-8") as arquivo:
                json.dump(CATRACAS_CACHE, arquivo, ensure_ascii=False, indent=2)
            os.replace(temporario, CATRACAS_CACHE_PATH)
        except OSError as erro:
            logger.warning("Não foi possível salvar o cache de catracas: %s", erro)


def situacao_catraca_conhecida(ip):
    with CATRACAS_CACHE_LOCK:
        return CATRACAS_CACHE.get(str(ip))


ECOMMERCE_CACHE_PATH = os.path.join(BASE_DIR, "ecommerce_lojas_cache.json")
ECOMMERCE_CACHE_LOCK = Lock()


def carregar_cache_ecommerce():
    try:
        with open(ECOMMERCE_CACHE_PATH, "r", encoding="utf-8") as arquivo:
            dados = json.load(arquivo)
        return dados if isinstance(dados, dict) else {}
    except (OSError, ValueError):
        return {}


ECOMMERCE_CACHE = carregar_cache_ecommerce()


def salvar_situacao_ecommerce(ip, pasta_existe):
    """Guarda a última existência conhecida das pastas de e-commerce da loja."""
    with ECOMMERCE_CACHE_LOCK:
        chave = str(ip)
        novo_valor = bool(pasta_existe)
        if chave in ECOMMERCE_CACHE and ECOMMERCE_CACHE[chave] == novo_valor:
            return
        ECOMMERCE_CACHE[chave] = novo_valor
        temporario = f"{ECOMMERCE_CACHE_PATH}.{os.getpid()}.tmp"
        try:
            os.makedirs(os.path.dirname(ECOMMERCE_CACHE_PATH) or BASE_DIR, exist_ok=True)
            with open(temporario, "w", encoding="utf-8") as arquivo:
                json.dump(ECOMMERCE_CACHE, arquivo, ensure_ascii=False, indent=2)
            os.replace(temporario, ECOMMERCE_CACHE_PATH)
        except OSError as erro:
            logger.warning("Não foi possível salvar o cache de e-commerce: %s", erro)


def situacao_ecommerce_conhecida(ip):
    with ECOMMERCE_CACHE_LOCK:
        return ECOMMERCE_CACHE.get(str(ip))


PERMISSOES_SISTEMA = {
    "dashboard": "Dashboard",
    "cadastro": "Cadastro",
    "ifood": "iFood",
    "caixas": "Caixas",
    "catracas": "Catracas",
    "syspdv": "Serviços SysPDV",
    "vpntef": "VPN TEF",
    "crm": "CRM",
    "analitico": "Analítico",
}

PERMISSOES_PADRAO = [chave for chave in PERMISSOES_SISTEMA if chave != "cadastro"]


LOJAS = [
    {"nome": "Loja 01", "ip": "192.168.1.80"},
    {"nome": "Loja 02", "ip": "192.168.2.20"},
    {"nome": "Loja 03", "ip": "192.168.3.91"},
    {"nome": "Loja 04", "ip": "192.168.4.18"},
    {"nome": "Loja 05", "ip": "192.168.5.20"},
    {"nome": "Loja 06", "ip": "192.168.6.14"},
    {"nome": "Loja 07", "ip": "192.168.7.125"},
    {"nome": "Loja 08", "ip": "192.168.8.20"},
    {"nome": "Loja 09", "ip": "192.168.9.20"},
    {"nome": "Loja 10", "ip": "192.168.10.20"},
    {"nome": "Loja 11", "ip": "192.168.11.20"},
    {"nome": "Loja 12", "ip": "192.168.12.20"},
    {"nome": "Loja 13", "ip": "192.168.13.20"},
    {"nome": "Loja 14", "ip": "192.168.14.20"},
    {"nome": "Loja 15", "ip": "192.168.15.20"},
    {"nome": "Loja 16", "ip": "192.168.16.20"},
    {"nome": "Loja 17", "ip": "192.168.17.20"},
    {"nome": "Loja 18", "ip": "192.168.18.20"},
    {"nome": "Loja 19", "ip": "192.168.19.20"},
    {"nome": "Loja 20", "ip": "192.168.20.20"},
    {"nome": "Loja 22", "ip": "192.168.22.20"},
    {"nome": "Loja 23", "ip": "192.168.23.20"},
    {"nome": "Loja 24", "ip": "192.168.24.20"},
    {"nome": "Loja 25", "ip": "192.168.25.20"},
    {"nome": "Loja 26", "ip": "192.168.26.20"},
    {"nome": "Loja 27", "ip": "192.168.27.20"},
    {"nome": "Loja 28", "ip": "192.168.28.20"},
    {"nome": "Loja 29", "ip": "192.168.29.20"},
    {"nome": "Loja 30", "ip": "192.168.30.20"},
    {"nome": "Loja 31", "ip": "192.168.31.20"},
    {"nome": "Loja 35", "ip": "192.168.35.20"},
    {"nome": "Loja 36", "ip": "192.168.36.20"},
    {"nome": "Loja 37", "ip": "192.168.37.20"},
    {"nome": "Loja 38", "ip": "192.168.38.20"},
    {"nome": "Loja 39", "ip": "192.168.39.20"},
]

LOJAS_OBRIGATORIAS_MONITORAMENTO = (
    {"nome": "Loja 15", "ip": "192.168.15.20"},
)

SERVICOS_VPNTEF = (
    ("openvpnserv", "openvpnserv.exe"),
    ("openvpnserv2", "openvpnserv2.exe"),
)

SERVIDORES_CRM = (
    {"nome": "CRM 153", "ip": "192.168.96.153"},
    {"nome": "CRM 152", "ip": "192.168.96.152"},
    {"nome": "CRM 151", "ip": "192.168.96.151"},
    {"nome": "CRM 163", "ip": "192.168.96.163"},
    {"nome": "CRM 164", "ip": "192.168.96.164"},
    {"nome": "CRM 169", "ip": "192.168.96.169"},
    {"nome": "CRM 168", "ip": "192.168.96.168"},
    {"nome": "CRM 165", "ip": "192.168.96.165"},
    {"nome": "CRM 167", "ip": "192.168.96.167"},
    {"nome": "CRM 162", "ip": "192.168.96.162"},
    {"nome": "CRM 150", "ip": "192.168.96.150"},
    {"nome": "CRM 67", "ip": "192.168.96.67"},
    {"nome": "CRM 66", "ip": "192.168.96.66"},
)


def incluir_lojas_obrigatorias_monitoramento(lojas):
    resultado = [dict(loja) for loja in lojas]
    nomes_existentes = {normalizar(loja.get("nome")) for loja in resultado}

    for loja in LOJAS_OBRIGATORIAS_MONITORAMENTO:
        if normalizar(loja["nome"]) not in nomes_existentes:
            resultado.append(dict(loja))
            nomes_existentes.add(normalizar(loja["nome"]))

    return resultado


def now_str():
    return datetime.now().strftime("%d/%m/%Y %H:%M:%S")


def normalizar(valor):
    return str(valor or "").strip().lower()


def texto_limitado(valor, tamanho, obrigatorio=False):
    texto = str(valor or "").strip()
    if obrigatorio and not texto:
        raise ValueError("campo_obrigatorio")
    if len(texto) > tamanho or any(ord(char) < 32 and char not in "\t" for char in texto):
        raise ValueError("campo_invalido")
    return texto


REDES_PRIVADAS = tuple(ipaddress.ip_network(rede) for rede in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"
))


def validar_ip_privado(valor, obrigatorio=True):
    texto = str(valor or "").strip()
    if not texto and not obrigatorio:
        return ""
    try:
        endereco = ipaddress.ip_address(texto)
    except ValueError as exc:
        raise ValueError("ip_invalido") from exc
    if endereco.version != 4 or not any(endereco in rede for rede in REDES_PRIVADAS):
        raise ValueError("ip_fora_da_rede_privada")
    return str(endereco)


def senha_forte(senha):
    return (
        12 <= len(senha) <= 128
        and re.search(r"[a-z]", senha)
        and re.search(r"[A-Z]", senha)
        and re.search(r"\d", senha)
        and re.search(r"[^A-Za-z0-9]", senha)
    )


def valor_booleano(dados, chave, padrao):
    valor = dados.get(chave, padrao)
    if not isinstance(valor, bool):
        raise ValueError("booleano_invalido")
    return valor


def numero_loja(nome):
    match = re.search(r"\d+", str(nome or ""))
    return int(match.group(0)) if match else 9999


def percentual(parte, total):
    if not total:
        return 0
    return round((parte / total) * 100)


def init_db():
    conn = get_db()
    cur = conn.cursor()
    auto_migrar = env_bool("DASHBOARD_AUTO_MIGRATE", DB_BACKEND == "sqlite")
    if auto_migrar:
        criar_schema(conn)

    total_usuarios = cur.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
    if total_usuarios == 0:
        usuario_admin = normalizar(os.getenv("DASHBOARD_ADMIN_USERNAME"))
        if os.getenv("DASHBOARD_ADMIN_PASSWORD", ""):
            conn.close()
            raise RuntimeError(
                "DASHBOARD_ADMIN_PASSWORD em texto simples não é aceita; "
                "use DASHBOARD_ADMIN_PASSWORD_FILE com um arquivo DPAPI."
            )
        arquivo_senha_admin = os.getenv("DASHBOARD_ADMIN_PASSWORD_FILE", "").strip()
        try:
            senha_admin = (
                ler_segredo(arquivo_senha_admin).decode("utf-8")
                if arquivo_senha_admin else ""
            )
        except (RuntimeError, UnicodeError) as exc:
            conn.close()
            raise RuntimeError("Senha inicial protegida inválida.") from exc
        if not re.fullmatch(r"[a-z0-9._-]{3,40}", usuario_admin) or not senha_forte(senha_admin):
            conn.close()
            raise RuntimeError(
                "Banco sem usuários. Defina DASHBOARD_ADMIN_USERNAME e "
                "DASHBOARD_ADMIN_PASSWORD_FILE apontando para um segredo DPAPI forte."
            )
        cur.execute("""
            INSERT INTO usuarios
                (nome, usuario, senha_hash, permissoes, administrador, ativo, criado_em)
            VALUES (?, ?, ?, ?, 1, 1, ?)
        """, (
            texto_limitado(os.getenv("DASHBOARD_ADMIN_NAME", usuario_admin), 80, True),
            usuario_admin,
            generate_password_hash(senha_admin),
            json.dumps(list(PERMISSOES_SISTEMA)),
            now_str(),
        ))
        logger.warning("Administrador inicial criado usando senha protegida pelo DPAPI.")

    conn.commit()
    conn.close()


def garantir_colunas_auditoria():
    if DB_BACKEND == "mysql" and not env_bool("DASHBOARD_AUTO_MIGRATE", False):
        return
    conn = get_db()
    cur = conn.cursor()

    for tabela in ["lojas", "caixas"]:
        if not coluna_existe(conn, tabela, "alterado_por"):
            cur.execute(f"ALTER TABLE {tabela} ADD COLUMN alterado_por VARCHAR(80)")
        if not coluna_existe(conn, tabela, "alterado_em"):
            cur.execute(f"ALTER TABLE {tabela} ADD COLUMN alterado_em VARCHAR(19)")

    if not coluna_existe(conn, "usuarios", "sessao_versao"):
        cur.execute("ALTER TABLE usuarios ADD COLUMN sessao_versao INTEGER NOT NULL DEFAULT 1")
    if not coluna_existe(conn, "usuarios", "alterado_por"):
        cur.execute("ALTER TABLE usuarios ADD COLUMN alterado_por VARCHAR(80)")
    if not coluna_existe(conn, "usuarios", "senha_alterada_em"):
        cur.execute("ALTER TABLE usuarios ADD COLUMN senha_alterada_em VARCHAR(19)")

    conn.commit()
    conn.close()


TENTATIVAS_LOGIN = defaultdict(deque)
TENTATIVAS_LOGIN_LOCK = Lock()
LOGIN_JANELA_SEGUNDOS = int(os.getenv("DASHBOARD_LOGIN_WINDOW_SECONDS", "900"))
LOGIN_MAX_TENTATIVAS = int(os.getenv("DASHBOARD_LOGIN_MAX_ATTEMPTS", "5"))
HASH_FICTICIO = generate_password_hash(secrets.token_urlsafe(32))


def gerar_csrf_token():
    token = session.get("_csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf_token"] = token
    return token


def chave_tentativa_login(usuario):
    return (request.remote_addr or "desconhecido", normalizar(usuario)[:40])


def login_bloqueado(chave):
    limite = time() - LOGIN_JANELA_SEGUNDOS
    with TENTATIVAS_LOGIN_LOCK:
        tentativas = TENTATIVAS_LOGIN[chave]
        while tentativas and tentativas[0] < limite:
            tentativas.popleft()
        return len(tentativas) >= LOGIN_MAX_TENTATIVAS


def registrar_falha_login(chave):
    with TENTATIVAS_LOGIN_LOCK:
        TENTATIVAS_LOGIN[chave].append(time())


@app.before_request
def validar_csrf_e_origem():
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    if request.path.startswith("/api/") and request.path != "/api/cadastro/importar-config" and not request.is_json:
        return jsonify({"erro": "content_type_invalido"}), 415
    recebido = request.headers.get("X-CSRF-Token", "") or request.form.get("csrf_token", "")
    esperado = session.get("_csrf_token", "")
    if not esperado or not recebido or not hmac.compare_digest(esperado, recebido):
        if request.path.startswith("/api/"):
            return jsonify({"erro": "csrf_invalido", "mensagem": "Recarregue a página e tente novamente."}), 403
        return "Requisição inválida. Recarregue a página e tente novamente.", 403
    return None


@app.after_request
def aplicar_cabecalhos_seguranca(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
        "font-src 'self' https://cdnjs.cloudflare.com data:; img-src 'self' data:; "
        "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
        "form-action 'self'"
    )
    if request.path != "/static" and not request.path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "no-store")
    if app.config["SESSION_COOKIE_SECURE"]:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.set_cookie(
        "XSRF-TOKEN", gerar_csrf_token(), secure=app.config["SESSION_COOKIE_SECURE"],
        httponly=False, samesite="Strict", path="/"
    )
    return response


@app.errorhandler(413)
def arquivo_grande_demais(_erro):
    return jsonify({"erro": "arquivo_muito_grande"}), 413


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "user" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"erro": "nao_autorizado"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated_function


def carregar_usuario(usuario):
    conn = get_db()
    try:
        return conn.execute(
            "SELECT * FROM usuarios WHERE usuario = ?", (normalizar(usuario),)
        ).fetchone()
    finally:
        conn.close()


def permissoes_do_usuario(registro):
    if not registro:
        return set()
    if bool(registro["administrador"]):
        return set(PERMISSOES_SISTEMA)
    try:
        permissoes = json.loads(registro["permissoes"] or "[]")
    except (TypeError, ValueError):
        permissoes = []
    return {item for item in permissoes if item in PERMISSOES_SISTEMA}


def usuario_atual():
    if not hasattr(g, "usuario_atual"):
        g.usuario_atual = carregar_usuario(session.get("user")) if session.get("user") else None
    return g.usuario_atual


def tem_permissao(permissao):
    return permissao in permissoes_do_usuario(usuario_atual())


def url_inicial_usuario():
    destinos = (
        ("dashboard", "home"),
        ("cadastro", "pagina_cadastro"),
        ("ifood", "monitoramento_ifood"),
        ("caixas", "monitoramento_caixas"),
        ("catracas", "monitoramento_catracas"),
        ("syspdv", "monitoramento_servicos_syspdv"),
        ("vpntef", "monitoramento_vpntef"),
        ("crm", "monitoramento_crm"),
        ("analitico", "pagina_analitico"),
    )
    for permissao, endpoint in destinos:
        if tem_permissao(permissao):
            return url_for(endpoint)
    return url_for("sem_acesso")


@app.context_processor
def contexto_permissoes():
    registro = usuario_atual()
    return {
        "tem_permissao": tem_permissao,
        "usuario_admin": bool(registro and registro["administrador"]),
        "csrf_token": gerar_csrf_token,
    }


@app.before_request
def autorizar_acesso_por_permissao():
    usuario = str(session.get("user", "")).strip().lower()

    if not usuario:
        return None

    registro = usuario_atual()
    if not registro or not bool(registro["ativo"]):
        session.clear()
        if request.path.startswith("/api/"):
            return jsonify({"erro": "nao_autorizado"}), 401
        return redirect(url_for("login"))

    try:
        versao_cookie = int(session.get("session_version", 0))
        versao_banco = int(registro["sessao_versao"] or 1)
    except (TypeError, ValueError):
        versao_cookie = 0
        versao_banco = 1
    if versao_cookie != versao_banco:
        session.clear()
        if request.path.startswith("/api/"):
            return jsonify({"erro": "sessao_expirada", "mensagem": "Entre novamente."}), 401
        return redirect(url_for("login"))

    rota_cadastro = request.path.startswith("/cadastro") or request.path.startswith("/api/cadastro")

    if rota_cadastro and not tem_permissao("cadastro"):
        if request.path.startswith("/api/"):
            return jsonify({
                "erro": "acesso_restrito",
                "mensagem": "Seu usuário não possui permissão para esta área."
            }), 403

        return render_template("acesso_restrito.html", usuario=session.get("user", "")), 403

    if request.path == "/cadastro/usuarios" or request.path.startswith("/api/usuarios"):
        permitido = bool(registro["administrador"])
    else:
        regras = (
            (("/monitoramento/ifood", "/api/ifood"), "ifood"),
            (("/monitoramento/caixas", "/api/caixas"), "caixas"),
            (("/monitoramento/catracas", "/api/catracas"), "catracas"),
            (("/monitoramento/servicos-syspdv", "/api/servicos-syspdv"), "syspdv"),
            (("/monitoramento/vpntef", "/api/vpntef"), "vpntef"),
            (("/monitoramento/crm", "/api/crm"), "crm"),
            (("/analitico", "/api/analitico"), "analitico"),
            (("/api/dashboard",), "dashboard"),
        )
        permissao = next(
            (chave for prefixos, chave in regras if any(request.path.startswith(p) for p in prefixos)),
            None
        )
        permitido = not permissao or tem_permissao(permissao)
        if request.path == "/":
            permitido = tem_permissao("dashboard")

    if not permitido:
        if request.path.startswith("/api/"):
            return jsonify({
                "erro": "acesso_restrito",
                "mensagem": "Seu usuário não possui permissão para esta área."
            }), 403
        return render_template("acesso_restrito.html", usuario=session.get("user", "")), 403

    return None


def ping_host(ip, timeout_ms=1000):
    try:
        ip = validar_ip_privado(ip)
        sistema = platform.system().lower()

        if sistema == "windows":
            comando = ["ping", "-n", "1", "-w", str(timeout_ms), ip]
        else:
            timeout_s = max(1, int(timeout_ms / 1000))
            comando = ["ping", "-c", "1", "-W", str(timeout_s), ip]

        resultado = subprocess.run(
            comando,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3
        )

        return resultado.returncode == 0
    except Exception:
        return False


def consultar_agente_loja(ip_loja, endpoint="/status", timeout=None):
    """
    Consulta o agente da loja.

    endpoint:
      /status   -> inclui terminal + caixas
      /caixas   -> somente caixas
      /terminal -> somente terminal

    Observacao importante:
    O agente pode demorar quando consulta Syspdv_pdv.exe via tasklist /S.
    Por isso o timeout do monitor precisa ser maior que o timeout interno do agente.
    """
    try:
        ip_loja = validar_ip_privado(ip_loja)
    except ValueError:
        return None
    endpoint = "/" + str(endpoint or "status").strip().lstrip("/")
    if endpoint not in {"/status", "/caixas", "/terminal"}:
        return None
    url = f"http://{ip_loja}:{AGENTE_PORTA}{endpoint}"
    tempo_limite = timeout if timeout is not None else AGENTE_TIMEOUT

    try:
        with urllib.request.urlopen(url, timeout=tempo_limite) as response:  # nosec B310
            if response.status != 200:
                return None

            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return None
            body = body.decode("utf-8")
            return json.loads(body)
    except Exception as e:
        logger.warning("Erro ao consultar agente %s: %s", url, e)
        return None


def consultar_agente_vpntef(ip_loja):
    try:
        ip_loja = validar_ip_privado(ip_loja)
    except ValueError:
        return None
    url = f"http://{ip_loja}:{AGENTE_VPNTEF_PORTA}/status"

    try:
        with urllib.request.urlopen(url, timeout=AGENTE_VPNTEF_TIMEOUT) as response:  # nosec B310
            if response.status != 200:
                return None

            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return None
            body = body.decode("utf-8")
            dados = json.loads(body)
            return dados if isinstance(dados, dict) else None
    except Exception as erro:
        logger.warning("Erro ao consultar agente VPN TEF %s: %s", url, erro)
        return None


def consultar_agente_crm(ip_servidor):
    try:
        ip_servidor = validar_ip_privado(ip_servidor)
    except ValueError:
        return None
    url = f"http://{ip_servidor}:{AGENTE_CRM_PORTA}/status"
    try:
        with urllib.request.urlopen(url, timeout=AGENTE_CRM_TIMEOUT) as response:  # nosec B310
            if response.status != 200:
                return None
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return None
            dados = json.loads(body.decode("utf-8"))
            return dados if isinstance(dados, dict) else None
    except Exception as erro:
        logger.warning("Erro ao consultar agente CRM %s: %s", url, erro)
        return None


def endereco_agente_vpntef(ip_loja):
    partes = str(ip_loja or "").strip().split(".")
    if len(partes) != 4:
        return str(ip_loja or "").strip()

    try:
        octetos = [int(parte) for parte in partes]
    except ValueError:
        return str(ip_loja or "").strip()

    if any(octeto < 0 or octeto > 255 for octeto in octetos):
        return str(ip_loja or "").strip()

    octetos[-1] = 79
    return ".".join(str(octeto) for octeto in octetos)


def consultar_agente_terminal_dados(ip_loja):
    """Consulta leve com cache e evita chamadas duplicadas simultâneas para o mesmo IP."""
    chave = str(ip_loja)
    agora = time()

    with TERMINAL_CACHE_LOCK:
        entrada = TERMINAL_CACHE.get(chave)
        if entrada and agora - entrada["gerado_em"] < TERMINAL_CACHE_SEGUNDOS:
            return entrada["dados"]
        trava_ip = TERMINAL_CACHE_IP_LOCKS.setdefault(chave, Lock())

    with trava_ip:
        agora = time()
        with TERMINAL_CACHE_LOCK:
            entrada = TERMINAL_CACHE.get(chave)
            if entrada and agora - entrada["gerado_em"] < TERMINAL_CACHE_SEGUNDOS:
                return entrada["dados"]

        dados = consultar_agente_loja(
            ip_loja,
            endpoint="/terminal",
            timeout=AGENTE_TERMINAL_TIMEOUT
        )

        with TERMINAL_CACHE_LOCK:
            TERMINAL_CACHE[chave] = {"dados": dados, "gerado_em": time()}

        return dados


def consultar_agente_terminal(ip_loja):
    data = consultar_agente_terminal_dados(ip_loja)

    if not data:
        return "offline"

    status_terminal = normalizar(data.get("systerminal", "offline"))
    return "online" if status_terminal == "online" else "offline"


def montar_mapas_caixas_agente(caixas_agente):
    mapa_por_nome = {}
    mapa_por_ip = {}

    for caixa in caixas_agente or []:
        nome = normalizar(caixa.get("nome"))
        ip = normalizar(caixa.get("ip"))

        if nome:
            mapa_por_nome[nome] = caixa

        if ip:
            mapa_por_ip[ip] = caixa

    return mapa_por_nome, mapa_por_ip


def mesclar_caixas_com_agente(caixas_rows, caixas_agente, nome_loja=""):
    """Mantem o cadastro como fonte oficial e usa o agente somente para status."""
    mapa_por_nome, mapa_por_ip = montar_mapas_caixas_agente(caixas_agente)
    caixas = []

    for row in caixas_rows:
        nome_banco = row["nome"] or ""
        ip_banco = row["ip"] or ""
        observacao_banco = row["observacao"] or ""

        agente = None

        if ip_banco:
            agente = mapa_por_ip.get(normalizar(ip_banco))

        if not agente:
            agente = mapa_por_nome.get(normalizar(nome_banco))

        status = normalizar(
            agente.get("status", "offline") if agente else row["status"] or "offline"
        )
        syspdv_caixa = "offline"
        if agente:
            syspdv_caixa = normalizar(
                agente.get("syspdv_caixa")
                or agente.get("syspdv")
                or agente.get("status_syspdv")
                or agente.get("Syspdv_pdv.exe")
                or "offline"
            )

        caixas.append({
            "id": row["id"],
            "loja": nome_loja,
            "caixa": nome_banco,
            "nome": nome_banco,
            "ip": ip_banco,
            "observacao": observacao_banco,
            "status": "online" if status == "online" else "offline",
            "syspdv_caixa": syspdv_caixa if syspdv_caixa in ["online", "offline", "erro"] else "offline",
            "fonte_status": "agente" if agente else "cadastro"
        })

    return caixas


def carregar_dados_dashboard():
    sondagens = {
        loja["ip"]: {"loja": loja, "rede_online": False, "agente_data": None}
        for loja in LOJAS
    }
    max_workers = min(48, max(16, len(LOJAS) * 2))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futuros = {}
        for loja in LOJAS:
            futuros[executor.submit(ping_host, loja["ip"])] = (loja["ip"], "rede")
            futuros[executor.submit(consultar_agente_terminal_dados, loja["ip"])] = (
                loja["ip"], "agente"
            )

        for futuro in as_completed(futuros):
            ip, tipo = futuros[futuro]
            try:
                if tipo == "rede":
                    sondagens[ip]["rede_online"] = bool(futuro.result())
                else:
                    sondagens[ip]["agente_data"] = futuro.result()
            except Exception as e:
                logger.warning("Erro na sondagem %s de %s: %s", tipo, ip, e)

    lojas_resultado = []
    for item in sondagens.values():
        loja = item["loja"]
        agente_data = item["agente_data"]
        rede_online = item["rede_online"] or agente_data is not None
        status_terminal = normalizar((agente_data or {}).get("systerminal", "offline"))
        lojas_resultado.append({
            "nome": loja["nome"],
            "ip": loja["ip"],
            "rede": "online" if rede_online else "offline",
            "terminal": "online" if status_terminal == "online" else "offline"
        })

    lojas_resultado.sort(key=lambda x: numero_loja(x["nome"]))

    total_lojas = len(lojas_resultado)
    rede_online = sum(1 for loja in lojas_resultado if loja["rede"] == "online")
    rede_offline = total_lojas - rede_online
    terminal_online = sum(1 for loja in lojas_resultado if loja["terminal"] == "online")
    terminal_offline = total_lojas - terminal_online

    return {
        "usuario": session.get("user", ""),
        "ultima_verificacao": now_str(),
        "total_lojas": total_lojas,
        "rede_online": rede_online,
        "rede_offline": rede_offline,
        "terminal_online": terminal_online,
        "terminal_offline": terminal_offline,
        "rede_percentual": percentual(rede_online, total_lojas),
        "terminal_percentual": percentual(terminal_online, total_lojas),
        "lojas": lojas_resultado
    }


def carregar_dados_caixas_loja(nome_loja):
    """
    Monitoramento baseado na aba Cadastro.
    A lista exibida vem da tabela caixas do SQLite.
    O agente da loja é usado apenas para atualizar STATUS e Syspdv quando encontrar IP/nome correspondente.
    Isso impede caixas duplicados vindos do agente.
    """
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT id, nome, ip, observacao FROM lojas WHERE nome = ?", (nome_loja,))
    loja = cur.fetchone()

    loja_info = None

    if loja:
        loja_info = {
            "id": loja["id"],
            "nome": loja["nome"],
            "ip": loja["ip"],
            "observacao": loja["observacao"] or ""
        }
    else:
        item = next((x for x in LOJAS if x["nome"] == nome_loja), None)
        if item:
            loja_info = {
                "id": None,
                "nome": item["nome"],
                "ip": item["ip"],
                "observacao": ""
            }

    if not loja_info:
        conn.close()
        return None

    caixas_rows = []

    if loja_info["id"]:
        cur.execute("""
            SELECT id, nome, ip, status, observacao
            FROM caixas
            WHERE loja_id = ?
            ORDER BY nome, id
        """, (loja_info["id"],))

        caixas_rows = cur.fetchall()

    agente_data = consultar_agente_loja(loja_info["ip"], endpoint="/caixas", timeout=AGENTE_TIMEOUT)
    agente_online = bool(agente_data and isinstance(agente_data.get("caixas"), list))
    caixas_agente = agente_data.get("caixas", []) if agente_online else []
    json_disponivel = agente_online and agente_data.get("config_existe") is not False

    # Nome, IP, observacao, inclusoes e exclusoes sempre refletem o SQLite.
    # O JSON do agente nao pode recriar caixas antigos nem sobrescrever alteracoes
    # feitas pela tela de Cadastro; ele complementa somente os estados em tempo real.
    caixas = mesclar_caixas_com_agente(
        caixas_rows,
        caixas_agente if json_disponivel else [],
        nome_loja=loja_info["nome"]
    )

    caixas.sort(key=lambda item: (numero_loja(item.get("nome", "")), normalizar(item.get("nome", ""))))
    conn.close()

    total_caixas = len(caixas)
    caixas_online = sum(1 for c in caixas if c["status"] == "online")
    caixas_offline = total_caixas - caixas_online

    if total_caixas == 0:
        status_loja = "sem_caixas"
    elif caixas_online == total_caixas:
        status_loja = "online"
    elif caixas_online == 0:
        status_loja = "offline"
    else:
        status_loja = "parcial"

    resposta = {
        "loja": loja_info["nome"],
        "ip": loja_info["ip"],
        "status_loja": status_loja,
        "total_caixas": total_caixas,
        "caixas_online": caixas_online,
        "caixas_offline": caixas_offline,
        "syspdv_caixa_online": sum(1 for c in caixas if c.get("syspdv_caixa") == "online"),
        "syspdv_caixa_offline": sum(1 for c in caixas if c.get("syspdv_caixa") != "online"),
        "caixas": caixas,
        "ultima_verificacao": now_str(),
        "agente_online": agente_online,
        "fonte": "cadastro_com_agente" if json_disponivel else "cadastro_sem_agente"
    }

    if agente_online:
        resposta.update({
            "agente_config_existe": agente_data.get("config_existe"),
            "agente_config_path": agente_data.get("config_path"),
            "agente_erro_config": agente_data.get("erro_config", ""),
            "agente_total_caixas_config": agente_data.get("total_caixas_config", len(caixas_agente))
        })
    else:
        resposta["agente_erro"] = "Agente nao respondeu dentro do timeout ou retornou formato invalido."

    return resposta



@app.route("/login", methods=["GET", "POST"])
def login():
    if "user" in session:
        return redirect(url_inicial_usuario())

    error = None

    if request.method == "POST":
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        chave = chave_tentativa_login(username)

        if login_bloqueado(chave):
            logger.warning("Login temporariamente bloqueado para origem %s", chave[0])
            return render_template(
                "login.html", error="Muitas tentativas. Aguarde alguns minutos e tente novamente."
            ), 429

        registro = carregar_usuario(username)
        hash_verificacao = registro["senha_hash"] if registro else HASH_FICTICIO
        senha_valida = check_password_hash(hash_verificacao, password)
        if registro and bool(registro["ativo"]) and senha_valida:
            with TENTATIVAS_LOGIN_LOCK:
                TENTATIVAS_LOGIN.pop(chave, None)
            session.clear()
            session["user"] = username
            session["session_version"] = int(registro["sessao_versao"] or 1)
            session.permanent = True
            gerar_csrf_token()
            g.usuario_atual = registro
            return redirect(url_inicial_usuario())

        registrar_falha_login(chave)
        logger.warning("Tentativa de login inválida da origem %s", chave[0])
        error = "Usuário ou senha inválidos."

    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def home():
    return render_template("index.html", usuario=session["user"])


@app.route("/analitico")
@login_required
def pagina_analitico():
    return render_template("analitico_opcoes.html", usuario=session["user"])


@app.route("/analitico/versoes-lojas")
@login_required
def analitico_versoes_lojas():
    return render_template("analitico.html", usuario=session["user"])


@app.route("/analitico/nfce-lojas")
@login_required
def analitico_nfce_lojas():
    return render_template("analitico_nfce.html", usuario=session["user"])


def consultar_versoes_syspdv_loja(loja):
    resultado = {
        "loja": loja["nome"],
        "ip": loja["ip"],
        "agente_online": False,
        "banco_online": False,
        "caixas": [],
        "erro": "Agente SysPDV sem resposta.",
    }
    try:
        ip_loja = validar_ip_privado(loja["ip"])
    except ValueError:
        resultado["erro"] = "Endereço da loja inválido."
        return resultado
    url = f"http://{ip_loja}:{AGENTE_PORTA}/versoes-syspdv"
    try:
        with urllib.request.urlopen(url, timeout=max(AGENTE_TIMEOUT, 12)) as response:  # nosec B310
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return resultado
            dados = json.loads(body.decode("utf-8"))
        if not isinstance(dados, dict):
            return resultado
        resultado["agente_online"] = True
        resultado["banco_online"] = bool(dados.get("sucesso"))
        resultado["erro"] = str(dados.get("erro", "") or "").strip()
        resultado["consultado_em"] = str(dados.get("consultado_em", "") or "").strip()
        caixas = dados.get("caixas", [])
        if isinstance(caixas, list):
            resultado["caixas"] = [
                {
                    "caixa": str(item.get("caixa", "") or "").strip(),
                    "versao": str(item.get("versao", "") or "").strip(),
                }
                for item in caixas if isinstance(item, dict)
            ]
    except urllib.error.HTTPError as erro:
        resultado["agente_online"] = True
        try:
            dados_erro = json.loads(erro.read().decode("utf-8"))
            resultado["erro"] = str(dados_erro.get("erro", erro.reason))
        except Exception:
            resultado["erro"] = f"Erro HTTP {erro.code} no agente."
    except Exception as erro:
        logger.warning("Falha ao consultar versoes SysPDV em %s: %s", loja["nome"], erro)
    return resultado


@app.route("/api/analitico/versoes-syspdv")
@login_required
def api_analitico_versoes_syspdv():
    conn = get_db()
    try:
        lojas = [dict(row) for row in conn.execute("SELECT nome, ip FROM lojas ORDER BY nome").fetchall()]
    finally:
        conn.close()
    lojas = incluir_lojas_obrigatorias_monitoramento(lojas or LOJAS)
    resultados = []
    with ThreadPoolExecutor(max_workers=min(32, max(4, len(lojas)))) as executor:
        futuros = [executor.submit(consultar_versoes_syspdv_loja, loja) for loja in lojas]
        for futuro in as_completed(futuros):
            resultados.append(futuro.result())
    resultados.sort(key=lambda item: numero_loja(item["loja"]))
    versoes = {}
    total_caixas = 0
    for loja in resultados:
        total_caixas += len(loja["caixas"])
        for caixa in loja["caixas"]:
            versao = caixa["versao"] or "Sem versão"
            versoes[versao] = versoes.get(versao, 0) + 1
    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "lojas_consultadas": sum(1 for item in resultados if item["banco_online"]),
        "total_caixas": total_caixas,
        "total_versoes": len(versoes),
        "distribuicao_versoes": dict(sorted(versoes.items(), key=lambda item: (-item[1], item[0]))),
        "lojas": resultados,
    })


def consultar_nfce_loja(loja):
    resultado = {
        "loja": loja["nome"], "ip": loja["ip"], "agente_online": False,
        "banco_online": False, "pendentes": 0, "rejeitadas": 0,
        "erro": "Agente SysPDV sem resposta.", "consultado_em": "",
    }
    try:
        ip_loja = validar_ip_privado(loja["ip"])
    except ValueError:
        resultado["erro"] = "Endereço da loja inválido."
        return resultado
    url = f"http://{ip_loja}:{AGENTE_PORTA}/nfce-status"
    try:
        with urllib.request.urlopen(url, timeout=max(AGENTE_TIMEOUT, 12)) as response:  # nosec B310
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                return resultado
            dados = json.loads(body.decode("utf-8"))
        if isinstance(dados, dict):
            resultado.update({
                "agente_online": True,
                "banco_online": bool(dados.get("sucesso")),
                "pendentes": max(0, int(dados.get("pendentes", 0) or 0)),
                "rejeitadas": max(0, int(dados.get("rejeitadas", 0) or 0)),
                "erro": str(dados.get("erro", "") or "").strip(),
                "consultado_em": str(dados.get("consultado_em", "") or "").strip(),
            })
    except urllib.error.HTTPError as erro:
        resultado["agente_online"] = True
        try:
            resultado["erro"] = str(json.loads(erro.read().decode("utf-8")).get("erro", erro.reason))
        except Exception:
            resultado["erro"] = f"Erro HTTP {erro.code} no agente."
    except Exception as erro:
        logger.warning("Falha ao consultar NFC-e em %s: %s", loja["nome"], erro)
    return resultado


@app.route("/api/analitico/nfce-lojas")
@login_required
def api_analitico_nfce_lojas():
    conn = get_db()
    try:
        lojas = [dict(row) for row in conn.execute("SELECT nome, ip FROM lojas ORDER BY nome").fetchall()]
    finally:
        conn.close()
    lojas = incluir_lojas_obrigatorias_monitoramento(lojas or LOJAS)
    resultados = []
    with ThreadPoolExecutor(max_workers=min(32, max(4, len(lojas)))) as executor:
        futuros = [executor.submit(consultar_nfce_loja, loja) for loja in lojas]
        for futuro in as_completed(futuros):
            resultados.append(futuro.result())
    resultados.sort(key=lambda item: numero_loja(item["loja"]))
    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "lojas_consultadas": sum(1 for item in resultados if item["banco_online"]),
        "total_pendentes": sum(item["pendentes"] for item in resultados),
        "total_rejeitadas": sum(item["rejeitadas"] for item in resultados),
        "lojas": resultados,
    })


@app.route("/sem-acesso")
@login_required
def sem_acesso():
    return render_template("acesso_restrito.html", usuario=session["user"]), 403


def normalizar_permissoes(dados):
    permissoes = dados.get("permissoes", [])
    if not isinstance(permissoes, list):
        return []
    return [chave for chave in PERMISSOES_SISTEMA if chave in permissoes]


def usuario_para_json(registro):
    return {
        "id": registro["id"],
        "nome": registro["nome"],
        "usuario": registro["usuario"],
        "permissoes": sorted(permissoes_do_usuario(registro)),
        "administrador": bool(registro["administrador"]),
        "ativo": bool(registro["ativo"]),
        "criado_em": registro["criado_em"],
        "alterado_em": registro["alterado_em"],
    }


@app.route("/cadastro/usuarios")
@login_required
def pagina_usuarios():
    conn = get_db()
    try:
        registros = conn.execute(
            "SELECT * FROM usuarios ORDER BY administrador DESC, nome COLLATE NOCASE"
        ).fetchall()
    finally:
        conn.close()
    return render_template(
        "usuarios.html",
        usuario=session["user"],
        usuarios=[usuario_para_json(item) for item in registros],
        permissoes_sistema=PERMISSOES_SISTEMA,
    )


@app.route("/api/usuarios", methods=["GET", "POST"])
@login_required
def api_usuarios():
    if request.method == "GET":
        conn = get_db()
        try:
            registros = conn.execute(
                "SELECT * FROM usuarios ORDER BY administrador DESC, nome COLLATE NOCASE"
            ).fetchall()
        finally:
            conn.close()
        return jsonify({"usuarios": [usuario_para_json(item) for item in registros]})

    dados = request.get_json(silent=True) or {}
    try:
        nome = texto_limitado(dados.get("nome"), 80, True)
        administrador = valor_booleano(dados, "administrador", False)
        ativo = valor_booleano(dados, "ativo", True)
    except ValueError:
        return jsonify({"erro": "dados_invalidos", "mensagem": "Verifique os campos enviados."}), 400
    login_usuario = normalizar(dados.get("usuario"))
    senha = str(dados.get("senha", ""))
    permissoes = normalizar_permissoes(dados)

    if len(nome) < 2:
        return jsonify({"erro": "nome_invalido", "mensagem": "Informe o nome do usuário."}), 400
    if not re.fullmatch(r"[a-z0-9._-]{3,40}", login_usuario):
        return jsonify({"erro": "usuario_invalido", "mensagem": "Use de 3 a 40 letras, números, ponto, hífen ou sublinhado."}), 400
    if not senha_forte(senha):
        return jsonify({"erro": "senha_invalida", "mensagem": "Use 12 ou mais caracteres, com maiúscula, minúscula, número e símbolo."}), 400

    conn = get_db()
    try:
        conn.execute("""
            INSERT INTO usuarios
                (nome, usuario, senha_hash, permissoes, administrador, ativo,
                 criado_em, alterado_por, senha_alterada_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            nome, login_usuario, generate_password_hash(senha), json.dumps(permissoes),
            int(administrador), int(ativo), now_str(), session.get("user", ""), now_str()
        ))
        conn.commit()
    except DB_INTEGRITY_ERRORS:
        return jsonify({"erro": "usuario_existente", "mensagem": "Este nome de usuário já está cadastrado."}), 409
    finally:
        conn.close()

    return jsonify({"ok": True, "mensagem": "Usuário cadastrado com sucesso."}), 201


@app.route("/api/usuarios/<int:usuario_id>", methods=["PUT", "DELETE"])
@login_required
def api_usuario_item(usuario_id):
    conn = get_db()
    try:
        registro = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
        if not registro:
            return jsonify({"erro": "usuario_nao_encontrado"}), 404

        if request.method == "DELETE":
            if registro["usuario"] == normalizar(session.get("user")):
                return jsonify({"erro": "operacao_bloqueada", "mensagem": "Você não pode excluir o próprio usuário."}), 400
            if bool(registro["administrador"]):
                total_admins = conn.execute(
                    "SELECT COUNT(*) FROM usuarios WHERE administrador = 1 AND ativo = 1"
                ).fetchone()[0]
                if total_admins <= 1:
                    return jsonify({"erro": "ultimo_admin", "mensagem": "O sistema precisa manter ao menos um administrador ativo."}), 400
            conn.execute("DELETE FROM usuarios WHERE id = ?", (usuario_id,))
            conn.commit()
            return jsonify({"ok": True, "mensagem": "Usuário excluído."})

        dados = request.get_json(silent=True) or {}
        try:
            nome = texto_limitado(dados.get("nome", registro["nome"]), 80, True)
            administrador = valor_booleano(dados, "administrador", bool(registro["administrador"]))
            ativo = valor_booleano(dados, "ativo", bool(registro["ativo"]))
        except ValueError:
            return jsonify({"erro": "dados_invalidos", "mensagem": "Verifique os campos enviados."}), 400
        login_usuario = normalizar(dados.get("usuario", registro["usuario"]))
        senha = str(dados.get("senha", ""))
        permissoes = normalizar_permissoes(dados)

        if len(nome) < 2:
            return jsonify({"erro": "nome_invalido", "mensagem": "Informe o nome do usuário."}), 400
        if not re.fullmatch(r"[a-z0-9._-]{3,40}", login_usuario):
            return jsonify({"erro": "usuario_invalido", "mensagem": "Use de 3 a 40 letras, números, ponto, hífen ou sublinhado."}), 400
        if senha and not senha_forte(senha):
            return jsonify({"erro": "senha_invalida", "mensagem": "Use 12 ou mais caracteres, com maiúscula, minúscula, número e símbolo."}), 400
        if registro["usuario"] == normalizar(session.get("user")) and not ativo:
            return jsonify({"erro": "operacao_bloqueada", "mensagem": "Você não pode desativar o próprio usuário."}), 400

        removendo_admin_ativo = bool(registro["administrador"] and registro["ativo"]) and (not administrador or not ativo)
        if removendo_admin_ativo:
            total_admins = conn.execute(
                "SELECT COUNT(*) FROM usuarios WHERE administrador = 1 AND ativo = 1"
            ).fetchone()[0]
            if total_admins <= 1:
                return jsonify({"erro": "ultimo_admin", "mensagem": "O sistema precisa manter ao menos um administrador ativo."}), 400

        duplicado = conn.execute(
            "SELECT id FROM usuarios WHERE usuario = ? AND id <> ?", (login_usuario, usuario_id)
        ).fetchone()
        if duplicado:
            return jsonify({"erro": "usuario_existente", "mensagem": "Este nome de usuário já está cadastrado."}), 409

        login_anterior = normalizar(registro["usuario"])
        alterando_proprio_usuario = login_anterior == normalizar(session.get("user"))
        credencial_alterada = login_usuario != login_anterior or bool(senha)
        nova_versao_sessao = int(registro["sessao_versao"] or 1) + int(credencial_alterada)
        senha_hash = generate_password_hash(senha) if senha else registro["senha_hash"]
        senha_alterada_em = now_str() if senha else registro["senha_alterada_em"]
        alterado_em = now_str()

        conn.execute("""
            UPDATE usuarios
            SET nome = ?, usuario = ?, senha_hash = ?, permissoes = ?,
                administrador = ?, ativo = ?, sessao_versao = ?,
                alterado_em = ?, alterado_por = ?, senha_alterada_em = ?
            WHERE id = ?
        """, (
            nome, login_usuario, senha_hash, json.dumps(permissoes),
            int(administrador), int(ativo), nova_versao_sessao,
            alterado_em, session.get("user", ""), senha_alterada_em, usuario_id,
        ))
        conn.commit()
        if alterando_proprio_usuario:
            session["user"] = login_usuario
            session["session_version"] = nova_versao_sessao
            g.usuario_atual = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
        return jsonify({
            "ok": True,
            "usuario": login_usuario,
            "mensagem": "Usuário e credenciais atualizados com sucesso."
        })
    except DB_INTEGRITY_ERRORS:
        return jsonify({"erro": "usuario_existente", "mensagem": "Este nome de usuário já está cadastrado."}), 409
    finally:
        conn.close()


@app.route("/cadastro")
@login_required
def pagina_cadastro():
    return render_template("cadastro_opcoes.html", usuario=session["user"])


@app.route("/cadastro/registros")
@login_required
def pagina_cadastro_registros():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, nome FROM lojas ORDER BY nome")
    lojas_banco = cur.fetchall()
    conn.close()

    lojas_select = [{"id": row["id"], "nome": row["nome"]} for row in lojas_banco]

    tipo_inicial = normalizar(request.args.get("tipo"))
    if tipo_inicial not in ("loja", "caixa"):
        tipo_inicial = "loja"

    return render_template(
        "cadastro.html",
        usuario=session["user"],
        lojas=lojas_select,
        tipo_inicial=tipo_inicial,
    )


@app.route("/api/cadastro/loja", methods=["POST"])
@login_required
def cadastrar_loja():
    try:
        data = request.get_json() or {}

        nome = texto_limitado(data.get("nome"), 80, True)
        ip = validar_ip_privado(data.get("ip"))
        observacao = texto_limitado(data.get("observacao"), 500)

        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM lojas WHERE nome = ? OR ip = ?", (nome, ip))
        existe = cur.fetchone()

        if existe:
            conn.close()
            return jsonify({"erro": "registro_duplicado"}), 409

        cur.execute("""
            INSERT INTO lojas (nome, ip, observacao, criado_por, criado_em)
            VALUES (?, ?, ?, ?, ?)
        """, (nome, ip, observacao, session.get("user", ""), now_str()))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Loja cadastrada com sucesso."})
    except ValueError as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        logger.exception("Erro ao cadastrar loja: %s", e)
        return jsonify({"erro": "falha_ao_cadastrar_loja"}), 500


@app.route("/api/cadastro/loja/<int:loja_id>", methods=["PUT"])
@login_required
def alterar_loja(loja_id):
    try:
        data = request.get_json() or {}

        nome = texto_limitado(data.get("nome"), 80, True)
        ip = validar_ip_privado(data.get("ip"))
        observacao = texto_limitado(data.get("observacao"), 500)

        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM lojas WHERE id = ?", (loja_id,))
        loja = cur.fetchone()

        if not loja:
            conn.close()
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        cur.execute("""
            SELECT id FROM lojas
            WHERE (nome = ? OR ip = ?) AND id <> ?
        """, (nome, ip, loja_id))

        duplicado = cur.fetchone()

        if duplicado:
            conn.close()
            return jsonify({"erro": "registro_duplicado"}), 409

        cur.execute("""
            UPDATE lojas
            SET nome = ?, ip = ?, observacao = ?,
                alterado_por = ?, alterado_em = ?
            WHERE id = ?
        """, (nome, ip, observacao, session.get("user", ""), now_str(), loja_id))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Loja alterada com sucesso."})
    except ValueError as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        logger.exception("Erro ao alterar loja: %s", e)
        return jsonify({"erro": "falha_ao_alterar_loja"}), 500


@app.route("/api/cadastro/loja/<int:loja_id>", methods=["DELETE"])
@login_required
def excluir_loja(loja_id):
    try:
        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM lojas WHERE id = ?", (loja_id,))
        loja = cur.fetchone()

        if not loja:
            conn.close()
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        cur.execute("DELETE FROM caixas WHERE loja_id = ?", (loja_id,))
        cur.execute("DELETE FROM lojas WHERE id = ?", (loja_id,))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Loja excluída com sucesso."})
    except Exception as e:
        logger.exception("Erro ao excluir loja: %s", e)
        return jsonify({"erro": "falha_ao_excluir_loja"}), 500


@app.route("/api/cadastro/caixa", methods=["POST"])
@login_required
def cadastrar_caixa():
    try:
        data = request.get_json() or {}

        loja_id = int(data.get("loja_id"))
        nome = texto_limitado(data.get("nome"), 80, True)
        ip = validar_ip_privado(data.get("ip"), obrigatorio=False)
        observacao = texto_limitado(data.get("observacao"), 500)
        if loja_id <= 0:
            raise ValueError("loja_invalida")

        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM lojas WHERE id = ?", (loja_id,))
        loja = cur.fetchone()

        if not loja:
            conn.close()
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        cur.execute("""
            SELECT id FROM caixas
            WHERE loja_id = ? AND nome = ?
        """, (loja_id, nome))

        existente = cur.fetchone()

        if existente:
            conn.close()
            return jsonify({"erro": "caixa_duplicado"}), 409

        cur.execute("""
            INSERT INTO caixas (loja_id, nome, ip, status, observacao, criado_por, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (loja_id, nome, ip, "offline", observacao, session.get("user", ""), now_str()))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Caixa cadastrado com sucesso."})
    except (TypeError, ValueError) as e:
        return jsonify({"erro": str(e) or "dados_invalidos"}), 400
    except Exception as e:
        logger.exception("Erro ao cadastrar caixa: %s", e)
        return jsonify({"erro": "falha_ao_cadastrar_caixa"}), 500


@app.route("/api/cadastro/caixa/<int:caixa_id>", methods=["PUT"])
@login_required
def alterar_caixa(caixa_id):
    try:
        data = request.get_json() or {}

        loja_id = int(data.get("loja_id"))
        nome = texto_limitado(data.get("nome"), 80, True)
        ip = validar_ip_privado(data.get("ip"), obrigatorio=False)
        observacao = texto_limitado(data.get("observacao"), 500)
        if loja_id <= 0:
            raise ValueError("loja_invalida")

        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM caixas WHERE id = ?", (caixa_id,))
        caixa = cur.fetchone()

        if not caixa:
            conn.close()
            return jsonify({"erro": "caixa_nao_encontrado"}), 404

        cur.execute("SELECT id FROM lojas WHERE id = ?", (loja_id,))
        loja = cur.fetchone()

        if not loja:
            conn.close()
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        cur.execute("""
            SELECT id FROM caixas
            WHERE loja_id = ? AND nome = ? AND id <> ?
        """, (loja_id, nome, caixa_id))

        duplicado = cur.fetchone()

        if duplicado:
            conn.close()
            return jsonify({"erro": "caixa_duplicado"}), 409

        cur.execute("""
            UPDATE caixas
            SET loja_id = ?, nome = ?, ip = ?, observacao = ?,
                alterado_por = ?, alterado_em = ?
            WHERE id = ?
        """, (loja_id, nome, ip, observacao, session.get("user", ""), now_str(), caixa_id))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Caixa alterado com sucesso."})
    except (TypeError, ValueError) as e:
        return jsonify({"erro": str(e) or "dados_invalidos"}), 400
    except Exception as e:
        logger.exception("Erro ao alterar caixa: %s", e)
        return jsonify({"erro": "falha_ao_alterar_caixa"}), 500


@app.route("/api/cadastro/caixas/excluir-lote", methods=["POST"])
@login_required
def excluir_caixas_lote():
    try:
        data = request.get_json() or {}
        ids = data.get("ids") or []

        if not isinstance(ids, list) or len(ids) > 500:
            return jsonify({"erro": "ids_invalidos"}), 400

        try:
            ids = [int(item) for item in ids]
        except (TypeError, ValueError):
            return jsonify({"erro": "ids_invalidos"}), 400

        ids = sorted(set(ids))

        if not ids:
            return jsonify({"erro": "nenhum_caixa_selecionado"}), 400

        conn = get_db()
        cur = conn.cursor()

        placeholders = ",".join(["?"] * len(ids))
        cur.execute(f"SELECT COUNT(*) AS total FROM caixas WHERE id IN ({placeholders})", ids)  # nosec B608
        row = cur.fetchone()
        total_encontrado = row["total"] if row else 0

        if total_encontrado == 0:
            conn.close()
            return jsonify({"erro": "caixas_nao_encontrados"}), 404

        cur.execute(f"DELETE FROM caixas WHERE id IN ({placeholders})", ids)  # nosec B608
        conn.commit()
        conn.close()

        return jsonify({
            "sucesso": True,
            "excluidos": total_encontrado,
            "mensagem": f"{total_encontrado} caixa(s) excluído(s) com sucesso."
        })
    except Exception as e:
        logger.exception("Erro ao excluir caixas em lote: %s", e)
        return jsonify({"erro": "falha_ao_excluir_caixas"}), 500


@app.route("/api/cadastro/caixa/<int:caixa_id>", methods=["DELETE"])
@login_required
def excluir_caixa(caixa_id):
    try:
        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM caixas WHERE id = ?", (caixa_id,))
        caixa = cur.fetchone()

        if not caixa:
            conn.close()
            return jsonify({"erro": "caixa_nao_encontrado"}), 404

        cur.execute("DELETE FROM caixas WHERE id = ?", (caixa_id,))

        conn.commit()
        conn.close()

        return jsonify({"sucesso": True, "mensagem": "Caixa excluído com sucesso."})
    except Exception as e:
        logger.exception("Erro ao excluir caixa: %s", e)
        return jsonify({"erro": "falha_ao_excluir_caixa"}), 500


@app.route("/api/cadastro/lojas", methods=["GET"])
@login_required
def listar_lojas_cadastradas():
    try:
        conn = get_db()
        cur = conn.cursor()

        cur.execute("""
            SELECT id, nome, ip, observacao, criado_por, criado_em,
                   alterado_por, alterado_em
            FROM lojas
            ORDER BY nome
        """)

        rows = cur.fetchall()
        conn.close()

        lojas = [{
            "id": row["id"],
            "nome": row["nome"],
            "ip": row["ip"],
            "observacao": row["observacao"] or "",
            "criado_por": row["criado_por"] or "",
            "criado_em": row["criado_em"],
            "alterado_por": row["alterado_por"] or "",
            "alterado_em": row["alterado_em"] or ""
        } for row in rows]

        return jsonify({"lojas": lojas})
    except Exception as e:
        print(f"Erro ao listar lojas: {e}")
        return jsonify({"erro": "falha_ao_listar_lojas"}), 500


@app.route("/api/cadastro/caixas", methods=["GET"])
@login_required
def listar_caixas_cadastrados():
    """
    Lista somente a página solicitada dos caixas cadastrados.

    A tela de cadastro usa o status salvo no banco. Consultar cada agente aqui
    fazia o tempo de resposta crescer a cada loja cadastrada; o status em tempo
    real continua disponível na tela própria de monitoramento.
    """
    try:
        try:
            pagina = max(1, int(request.args.get("pagina", 1)))
            por_pagina = min(100, max(1, int(request.args.get("por_pagina", 20))))
        except (TypeError, ValueError):
            return jsonify({"erro": "paginacao_invalida"}), 400

        loja_id_raw = request.args.get("loja_id", "").strip()
        loja_id = None
        if loja_id_raw:
            try:
                loja_id = int(loja_id_raw)
            except ValueError:
                return jsonify({"erro": "loja_id_invalido"}), 400

        conn = get_db()
        cur = conn.cursor()

        if loja_id is None:
            cur.execute("SELECT COUNT(*) AS total FROM caixas c")
        else:
            cur.execute("SELECT COUNT(*) AS total FROM caixas c WHERE c.loja_id = ?", (loja_id,))
        total = cur.fetchone()["total"]

        if request.args.get("somente_ids") == "1":
            if loja_id is None:
                cur.execute("SELECT c.id FROM caixas c ORDER BY c.id")
            else:
                cur.execute("SELECT c.id FROM caixas c WHERE c.loja_id = ? ORDER BY c.id", (loja_id,))
            ids = [row["id"] for row in cur.fetchall()]
            conn.close()
            return jsonify({"ids": ids, "total": total})

        total_paginas = max(1, (total + por_pagina - 1) // por_pagina)
        pagina = min(pagina, total_paginas)
        offset = (pagina - 1) * por_pagina

        consulta = """
            SELECT c.id, c.loja_id, c.nome, c.ip, c.status, c.observacao,
                   c.criado_por, c.criado_em, c.alterado_por, c.alterado_em,
                   l.nome AS loja_nome
            FROM caixas c
            INNER JOIN lojas l ON l.id = c.loja_id
        """
        if loja_id is None:
            cur.execute(
                consulta + " ORDER BY l.nome, c.nome, c.id LIMIT ? OFFSET ?",
                (por_pagina, offset),
            )
        else:
            cur.execute(
                consulta + " WHERE c.loja_id = ? ORDER BY l.nome, c.nome, c.id LIMIT ? OFFSET ?",
                (loja_id, por_pagina, offset),
            )

        rows = cur.fetchall()
        conn.close()

        caixas = []

        for row in rows:
            nome_banco = row["nome"] or ""
            ip_banco = row["ip"] or ""
            status = normalizar(row["status"] or "offline")

            caixas.append({
                "id": row["id"],
                "loja_id": row["loja_id"],
                "loja_nome": row["loja_nome"],
                "nome": nome_banco,
                "ip": ip_banco,
                "status": "online" if status == "online" else "offline",
                "observacao": row["observacao"] or "",
                "criado_por": row["criado_por"] or "",
                "criado_em": row["criado_em"],
                "alterado_por": row["alterado_por"] or "",
                "alterado_em": row["alterado_em"] or ""
            })

        return jsonify({
            "caixas": caixas,
            "total": total,
            "pagina": pagina,
            "por_pagina": por_pagina,
            "total_paginas": total_paginas
        })
    except Exception as e:
        logger.exception("Erro ao listar caixas cadastrados: %s", e)
        return jsonify({"erro": "falha_ao_listar_caixas"}), 500


@app.route("/api/cadastro/exportar-config/<int:loja_id>", methods=["GET"])
@login_required
def exportar_caixas_config(loja_id):
    try:
        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id, nome, ip, observacao FROM lojas WHERE id = ?", (loja_id,))
        loja = cur.fetchone()

        if not loja:
            conn.close()
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        cur.execute("""
            SELECT nome, ip, observacao
            FROM caixas
            WHERE loja_id = ?
            ORDER BY nome
        """, (loja_id,))

        rows = cur.fetchall()
        conn.close()

        caixas = []

        for row in rows:
            caixas.append({
                "nome": row["nome"] or "",
                "ip": row["ip"] or "",
                "observacao": row["observacao"] or ""
            })

        conteudo = {
            "loja": loja["nome"],
            "ip": loja["ip"] or "",
            "observacao": loja["observacao"] or "",
            "caixas": caixas
        }

        nome_seguro = secure_filename(str(loja["nome"]))[:80] or "loja"
        nome_arquivo = f"caixas_config_{nome_seguro}.json"
        body = json.dumps(conteudo, ensure_ascii=False, indent=2)

        return Response(
            body,
            mimetype="application/json; charset=utf-8",
            headers={
                "Content-Disposition": f"attachment; filename={nome_arquivo}"
            }
        )
    except Exception as e:
        logger.exception("Erro ao exportar caixas_config.json: %s", e)
        return jsonify({"erro": "falha_ao_exportar_config"}), 500


@app.route("/api/cadastro/caixas-config/<int:loja_id>", methods=["GET"])
@login_required
def baixar_caixas_config(loja_id):
    return exportar_caixas_config(loja_id)


@app.route("/api/cadastro/importar-config", methods=["POST"])
@login_required
def importar_caixas_config():
    try:
        if "arquivo" not in request.files:
            return jsonify({"erro": "arquivo_nao_enviado"}), 400

        arquivo = request.files["arquivo"]

        if not arquivo or not arquivo.filename:
            return jsonify({"erro": "arquivo_invalido"}), 400

        if not arquivo.filename.lower().endswith(".json"):
            return jsonify({"erro": "tipo_de_arquivo_invalido"}), 400

        try:
            data = json.loads(arquivo.read().decode("utf-8-sig"))
        except Exception:
            return jsonify({"erro": "json_invalido"}), 400

        if not isinstance(data, dict):
            return jsonify({"erro": "estrutura_json_invalida"}), 400

        try:
            nome_loja = texto_limitado(data.get("loja"), 80, True)
            ip_loja_raw = str(data.get("ip", "")).strip()
            ip_loja = validar_ip_privado(ip_loja_raw) if ip_loja_raw else ""
            observacao_loja = texto_limitado(data.get("observacao"), 500)
        except ValueError as erro:
            return jsonify({"erro": str(erro)}), 400
        caixas = data.get("caixas", [])

        if not isinstance(caixas, list) or len(caixas) > 1000:
            return jsonify({"erro": "caixas_deve_ser_lista"}), 400

        caixas_normalizadas = []
        try:
            for caixa in caixas:
                if not isinstance(caixa, dict):
                    raise ValueError("caixa_invalido")
                caixas_normalizadas.append({
                    "nome": texto_limitado(caixa.get("nome"), 80, True),
                    "ip": validar_ip_privado(caixa.get("ip"), obrigatorio=False),
                    "observacao": texto_limitado(caixa.get("observacao"), 500),
                })
        except ValueError as erro:
            return jsonify({"erro": str(erro)}), 400

        conn = get_db()
        cur = conn.cursor()

        cur.execute("SELECT id FROM lojas WHERE nome = ?", (nome_loja,))
        loja_existente = cur.fetchone()

        if loja_existente:
            loja_id = loja_existente["id"]

            cur.execute("""
                UPDATE lojas
                SET ip = COALESCE(NULLIF(?, ''), ip),
                    observacao = COALESCE(NULLIF(?, ''), observacao),
                    alterado_por = ?, alterado_em = ?
                WHERE id = ?
            """, (ip_loja, observacao_loja, session.get("user", ""), now_str(), loja_id))
        else:
            if not ip_loja:
                conn.close()
                return jsonify({"erro": "ip_loja_obrigatorio_para_nova_loja"}), 400

            cur.execute("""
                INSERT INTO lojas (nome, ip, observacao, criado_por, criado_em)
                VALUES (?, ?, ?, ?, ?)
            """, (nome_loja, ip_loja, observacao_loja, session.get("user", ""), now_str()))

            loja_id = cur.lastrowid

        importados = 0
        atualizados = 0
        ignorados = 0

        for caixa in caixas_normalizadas:
            nome_caixa = caixa["nome"]
            ip_caixa = caixa["ip"]
            observacao_caixa = caixa["observacao"]

            cur.execute("""
                SELECT id FROM caixas
                WHERE loja_id = ? AND nome = ?
            """, (loja_id, nome_caixa))

            caixa_existente = cur.fetchone()

            if caixa_existente:
                cur.execute("""
                    UPDATE caixas
                    SET ip = ?, observacao = ?,
                        alterado_por = ?, alterado_em = ?
                    WHERE id = ?
                """, (ip_caixa, observacao_caixa, session.get("user", ""), now_str(), caixa_existente["id"]))
                atualizados += 1
            else:
                cur.execute("""
                    INSERT INTO caixas (loja_id, nome, ip, status, observacao, criado_por, criado_em)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (loja_id, nome_caixa, ip_caixa, "offline", observacao_caixa, session.get("user", ""), now_str()))
                importados += 1

        conn.commit()
        conn.close()

        return jsonify({
            "sucesso": True,
            "mensagem": "Configuração importada com sucesso.",
            "loja": nome_loja,
            "caixas_importados": importados,
            "caixas_atualizados": atualizados,
            "caixas_ignorados": ignorados
        })
    except Exception as e:
        logger.exception("Erro ao importar caixas_config.json: %s", e)
        return jsonify({"erro": "falha_ao_importar_config"}), 500


@app.route("/api/dashboard")
@login_required
def api_dashboard():
    try:
        agora_cache = time()

        with DASHBOARD_CACHE_LOCK:
            if (
                DASHBOARD_CACHE["dados"] is not None
                and agora_cache - DASHBOARD_CACHE["gerado_em"] < DASHBOARD_CACHE_SEGUNDOS
            ):
                return jsonify(DASHBOARD_CACHE["dados"])

        with DASHBOARD_REFRESH_LOCK:
            agora_cache = time()
            with DASHBOARD_CACHE_LOCK:
                if (
                    DASHBOARD_CACHE["dados"] is not None
                    and agora_cache - DASHBOARD_CACHE["gerado_em"] < DASHBOARD_CACHE_SEGUNDOS
                ):
                    return jsonify(DASHBOARD_CACHE["dados"])

            dados = carregar_dados_dashboard()

            with DASHBOARD_CACHE_LOCK:
                DASHBOARD_CACHE["dados"] = dados
                DASHBOARD_CACHE["gerado_em"] = time()

        return jsonify(dados)
    except Exception as e:
        logger.exception("Erro na rota /api/dashboard: %s", e)
        return jsonify({"erro": "falha_ao_carregar_dashboard"}), 500


@app.route("/monitoramento/ifood")
@login_required
def monitoramento_ifood():
    return render_template("monitor_ifood.html", usuario=session["user"])


def verificar_ifood_loja(loja):
    nome = loja["nome"]
    ip = loja["ip"]
    agente_data = consultar_agente_terminal_dados(ip)

    if not agente_data:
        pasta_existe = situacao_ecommerce_conhecida(ip)
        return {
            "loja": nome,
            "ip": ip,
            "hostname": "",
            "agente": "offline",
            "monitorado": pasta_existe is True,
            "status": "sem_ecommerce" if pasta_existe is False else "offline",
            "processo": ""
        }

    pasta_informada = "ecommerce_pasta_existe" in agente_data
    pasta_existe = agente_data.get("ecommerce_pasta_existe") is True if pasta_informada else None
    if pasta_informada:
        salvar_situacao_ecommerce(ip, pasta_existe)

    monitorado = pasta_existe is True
    status_ifood = normalizar(agente_data.get("syspdv_service", "offline"))

    return {
        "loja": nome,
        "ip": ip,
        "hostname": str(agente_data.get("hostname", "") or "").strip(),
        "agente": "online",
        "monitorado": monitorado,
        "status": (
            "online" if monitorado and status_ifood == "online"
            else "offline" if monitorado
            else "sem_ecommerce" if pasta_existe is False
            else "nao_monitorado"
        ),
        "processo": str(agente_data.get("syspdv_service_processo", "") or "").strip()
    }


@app.route("/api/ifood")
@login_required
def api_ifood():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT nome, ip FROM lojas ORDER BY nome")
    lojas_banco = [dict(row) for row in cur.fetchall()]
    conn.close()

    lojas = incluir_lojas_obrigatorias_monitoramento(lojas_banco or LOJAS)
    resultados = []
    max_workers = min(48, max(8, len(lojas)))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futuros = [executor.submit(verificar_ifood_loja, loja) for loja in lojas]

        for futuro in as_completed(futuros):
            try:
                resultados.append(futuro.result())
            except Exception as e:
                logger.exception("Erro ao verificar integracao iFood: %s", e)

    resultados.sort(key=lambda item: numero_loja(item["loja"]))
    monitoradas = [item for item in resultados if item["monitorado"]]

    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "agentes_online": sum(1 for item in resultados if item["agente"] == "online"),
        "lojas_monitoradas": len(monitoradas),
        "servicos_online": sum(1 for item in monitoradas if item["status"] == "online"),
        "servicos_offline": sum(1 for item in monitoradas if item["status"] == "offline"),
        "lojas": resultados
    })



@app.route("/api/caixas/debug")
@login_required
def api_caixas_debug():
    registro = usuario_atual()
    if not env_bool("DASHBOARD_ENABLE_DEBUG_ENDPOINTS", False) or not bool(registro and registro["administrador"]):
        return jsonify({"erro": "nao_encontrado"}), 404
    nome_loja = request.args.get("loja", "").strip()

    if not nome_loja:
        return jsonify({"erro": "loja_nao_informada"}), 400

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, nome, ip, observacao FROM lojas WHERE nome = ?", (nome_loja,))
    loja = cur.fetchone()

    if not loja:
        conn.close()
        return jsonify({"erro": "loja_nao_encontrada"}), 404

    cur.execute("""
        SELECT id, nome, ip, status, observacao
        FROM caixas
        WHERE loja_id = ?
        ORDER BY nome
    """, (loja["id"],))
    caixas_banco = [dict(row) for row in cur.fetchall()]
    conn.close()

    agente_caixas = consultar_agente_loja(loja["ip"], endpoint="/caixas", timeout=AGENTE_TIMEOUT)

    return jsonify({
        "loja_banco": dict(loja),
        "caixas_banco": caixas_banco,
        "agente_timeout": AGENTE_TIMEOUT,
        "agente_endpoint": f"http://{loja['ip']}:{AGENTE_PORTA}/caixas",
        "agente_resposta": agente_caixas
    })


@app.route("/monitoramento/caixas")
@login_required
def monitoramento_caixas():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, nome FROM lojas ORDER BY nome")
    lojas_banco = cur.fetchall()
    conn.close()

    nomes_lojas = [row["nome"] for row in lojas_banco] if lojas_banco else [loja["nome"] for loja in LOJAS]

    return render_template("monitor_caixas.html", usuario=session["user"], lojas=nomes_lojas)


@app.route("/api/caixas/loja")
@login_required
def api_caixas_loja():
    try:
        nome_loja = request.args.get("loja", "").strip()

        if not nome_loja:
            return jsonify({"erro": "loja_nao_informada"}), 400

        dados = carregar_dados_caixas_loja(nome_loja)

        if not dados:
            return jsonify({"erro": "loja_nao_encontrada"}), 404

        return jsonify(dados)
    except Exception as e:
        logger.exception("Erro na rota /api/caixas/loja: %s", e)
        return jsonify({"erro": "falha_ao_carregar_caixas_loja"}), 500


@app.route("/monitoramento/catracas")
@login_required
def monitoramento_catracas():
    return render_template("monitor_catracas.html", usuario=session["user"])


def verificar_catraca_loja(loja):
    nome = loja["nome"]
    ip = loja["ip"]
    agente_data = consultar_agente_terminal_dados(ip)

    if not agente_data:
        pasta_existe = situacao_catraca_conhecida(ip)
        return {
            "loja": nome,
            "ip": ip,
            "hostname": "",
            "agente": "offline",
            "monitorado": pasta_existe is True,
            "status": "sem_catraca" if pasta_existe is False else "offline",
            "processo": ""
        }

    pasta_informada = "sqs_pasta_existe" in agente_data
    pasta_existe = agente_data.get("sqs_pasta_existe") is True if pasta_informada else None
    if pasta_informada:
        salvar_situacao_catraca(ip, pasta_existe)

    monitorado = pasta_existe is True
    status_sqssaida = normalizar(agente_data.get("sqssaida", "offline"))

    return {
        "loja": nome,
        "ip": ip,
        "hostname": str(agente_data.get("hostname", "") or "").strip(),
        "agente": "online",
        "monitorado": monitorado,
        "status": (
            "online" if monitorado and status_sqssaida == "online"
            else "offline" if monitorado
            else "sem_catraca" if pasta_existe is False
            else "nao_monitorado"
        ),
        "processo": str(agente_data.get("sqssaida_processo", "") or "").strip()
    }


@app.route("/api/catracas")
@login_required
def api_catracas():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT nome, ip FROM lojas ORDER BY nome")
    lojas_banco = [dict(row) for row in cur.fetchall()]
    conn.close()

    lojas = incluir_lojas_obrigatorias_monitoramento(lojas_banco or LOJAS)
    resultados = []
    max_workers = min(48, max(8, len(lojas)))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futuros = [executor.submit(verificar_catraca_loja, loja) for loja in lojas]

        for futuro in as_completed(futuros):
            try:
                resultados.append(futuro.result())
            except Exception as e:
                logger.exception("Erro ao verificar catraca: %s", e)

    resultados.sort(key=lambda item: numero_loja(item["loja"]))
    monitoradas = [item for item in resultados if item["monitorado"]]

    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "agentes_online": sum(1 for item in resultados if item["agente"] == "online"),
        "catracas_monitoradas": len(monitoradas),
        "catracas_online": sum(1 for item in monitoradas if item["status"] == "online"),
        "catracas_offline": sum(1 for item in monitoradas if item["status"] == "offline"),
        "lojas": resultados
    })


@app.route("/monitoramento/servicos-syspdv")
@login_required
def monitoramento_servicos_syspdv():
    return render_template("monitor_syspdv.html", usuario=session["user"])


SERVICOS_SYSPDV = (
    ("offline", "Offline", "ICRMOFFServLoja.exe"),
    ("mongodb", "MongoDB", "mongod.exe"),
    ("scanntech", "Scanntech", "SysPDVService.exe"),
    ("syspdvweb", "SysPDVWeb", "wrapper.exe"),
    ("sqlserver", "SQLSERVER", "sqlservr.exe"),
)


def _numero_ou_none(valor):
    try:
        return round(float(valor), 1)
    except (TypeError, ValueError):
        return None


def verificar_servicos_syspdv_loja(loja):
    agente_data = consultar_agente_terminal_dados(loja["ip"])
    base = {
        "loja": loja["nome"],
        "ip": loja["ip"],
        "hostname": "",
        "loja_status": "offline",
        "agente_atualizado": False,
        "ultimo_reinicio": "",
        "uptime_segundos": None,
        "cpu_percent": None,
        "ram_percent": None,
        "ram_usada_gb": None,
        "ram_total_gb": None,
        "disco_c_livre_gb": None,
        "disco_c_total_gb": None,
        "disco_c_livre_percent": None,
        "servicos": {
            chave: {
                "descricao": descricao,
                "executavel": executavel,
                "status": "indisponivel",
                "processo_encontrado": "",
            }
            for chave, descricao, executavel in SERVICOS_SYSPDV
        },
    }

    if not agente_data:
        return base

    base["loja_status"] = "online"
    base["hostname"] = str(agente_data.get("hostname", "") or "").strip()
    servicos_recebidos = agente_data.get("servicos_syspdv")
    metricas = agente_data.get("metricas_sistema")
    base["agente_atualizado"] = isinstance(servicos_recebidos, dict) and isinstance(metricas, dict)

    if isinstance(servicos_recebidos, dict):
        for chave, descricao, executavel in SERVICOS_SYSPDV:
            recebido = servicos_recebidos.get(chave, {})
            status = normalizar(recebido.get("status")) if isinstance(recebido, dict) else ""
            base["servicos"][chave] = {
                "descricao": descricao,
                "executavel": executavel,
                "status": status if status in ("online", "offline") else "indisponivel",
                "processo_encontrado": (
                    str(recebido.get("processo_encontrado", "") or "").strip()
                    if isinstance(recebido, dict) else ""
                ),
            }
    else:
        for servico in base["servicos"].values():
            servico["status"] = "nao_monitorado"

    if isinstance(metricas, dict):
        base.update({
            "ultimo_reinicio": str(metricas.get("ultimo_reinicio", "") or "").strip(),
            "uptime_segundos": metricas.get("uptime_segundos"),
            "cpu_percent": _numero_ou_none(metricas.get("cpu_percent")),
            "ram_percent": _numero_ou_none(metricas.get("ram_percent")),
            "ram_usada_gb": _numero_ou_none(metricas.get("ram_usada_gb")),
            "ram_total_gb": _numero_ou_none(metricas.get("ram_total_gb")),
            "disco_c_livre_gb": _numero_ou_none(metricas.get("disco_c_livre_gb")),
            "disco_c_total_gb": _numero_ou_none(metricas.get("disco_c_total_gb")),
            "disco_c_livre_percent": _numero_ou_none(metricas.get("disco_c_livre_percent")),
        })

    return base


@app.route("/api/servicos-syspdv")
@login_required
def api_servicos_syspdv():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT nome, ip FROM lojas ORDER BY nome")
    lojas_banco = [dict(row) for row in cur.fetchall()]
    conn.close()

    lojas = incluir_lojas_obrigatorias_monitoramento(lojas_banco or LOJAS)
    forcar_atualizacao = normalizar(request.args.get("forcar", "")) in (
        "1", "true", "sim", "yes"
    )

    if forcar_atualizacao:
        # O botao "Atualizar agora" deve consultar cada agente novamente,
        # sem reutilizar o cache leve de /terminal.
        with TERMINAL_CACHE_LOCK:
            for loja in lojas:
                TERMINAL_CACHE.pop(str(loja["ip"]), None)

    resultados = []
    max_workers = min(48, max(8, len(lojas)))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futuros = [executor.submit(verificar_servicos_syspdv_loja, loja) for loja in lojas]
        for futuro in as_completed(futuros):
            try:
                resultados.append(futuro.result())
            except Exception as e:
                logger.exception("Erro ao verificar Servicos SysPDV: %s", e)

    resultados.sort(key=lambda item: numero_loja(item["loja"]))
    servicos_online = 0
    servicos_offline = 0
    for loja in resultados:
        servicos_online += sum(
            1 for servico in loja["servicos"].values() if servico["status"] == "online"
        )
        servicos_offline += sum(
            1 for servico in loja["servicos"].values() if servico["status"] == "offline"
        )

    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "lojas_online": sum(1 for item in resultados if item["loja_status"] == "online"),
        "lojas_offline": sum(1 for item in resultados if item["loja_status"] == "offline"),
        "agentes_atualizados": sum(1 for item in resultados if item["agente_atualizado"]),
        "servicos_online": servicos_online,
        "servicos_offline": servicos_offline,
        "atualizacao_forcada": forcar_atualizacao,
        "lojas": resultados,
    })


@app.route("/monitoramento/vpntef")
@login_required
def monitoramento_vpntef():
    return render_template("monitor_vpntef.html", usuario=session["user"])


def verificar_vpntef_loja(loja):
    ip_loja = loja["ip"]
    ip_agente = endereco_agente_vpntef(ip_loja)
    base = {
        "loja": loja["nome"],
        "ip": ip_agente,
        "ip_loja": ip_loja,
        "agente_status": "offline",
        "agente_atualizado": False,
        "hostname": "",
        "verificado_em": "",
        "servicos": {
            chave: {
                "executavel": executavel,
                "status": "indisponivel",
                "instancias": 0,
            }
            for chave, executavel in SERVICOS_VPNTEF
        },
    }

    dados = consultar_agente_vpntef(ip_agente)
    if not dados:
        return base

    base["agente_status"] = "online"
    base["agente_atualizado"] = normalizar(dados.get("agente")) == "vpn_tef"
    base["hostname"] = str(dados.get("hostname", "") or "").strip()
    base["verificado_em"] = str(dados.get("verificado_em", "") or "").strip()
    servicos_recebidos = dados.get("servicos")

    if not isinstance(servicos_recebidos, dict):
        return base

    for chave, executavel in SERVICOS_VPNTEF:
        recebido = servicos_recebidos.get(chave, {})
        if not isinstance(recebido, dict):
            continue

        status = normalizar(recebido.get("status"))
        try:
            instancias = max(0, int(recebido.get("instancias", 0) or 0))
        except (TypeError, ValueError):
            instancias = 0

        base["servicos"][chave] = {
            "executavel": executavel,
            "status": status if status in ("online", "offline") else "indisponivel",
            "instancias": instancias,
        }

    return base


@app.route("/api/vpntef")
@login_required
def api_vpntef():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT nome, ip FROM lojas ORDER BY nome")
    lojas_banco = [dict(row) for row in cur.fetchall()]
    conn.close()

    lojas = incluir_lojas_obrigatorias_monitoramento(lojas_banco or LOJAS)
    resultados = []
    max_workers = min(48, max(8, len(lojas)))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futuros = [executor.submit(verificar_vpntef_loja, loja) for loja in lojas]
        for futuro in as_completed(futuros):
            try:
                resultados.append(futuro.result())
            except Exception as erro:
                logger.exception("Erro ao verificar VPN TEF: %s", erro)

    resultados.sort(key=lambda item: numero_loja(item["loja"]))

    def servico_online(item, chave):
        return item["servicos"][chave]["status"] == "online"

    return jsonify({
        "ultima_verificacao": now_str(),
        "total_lojas": len(resultados),
        "agentes_online": sum(1 for item in resultados if item["agente_status"] == "online"),
        "agentes_offline": sum(1 for item in resultados if item["agente_status"] == "offline"),
        "openvpnserv_online": sum(1 for item in resultados if servico_online(item, "openvpnserv")),
        "openvpnserv2_online": sum(1 for item in resultados if servico_online(item, "openvpnserv2")),
        "lojas_alerta": sum(
            1 for item in resultados
            if item["agente_status"] == "online" and not (
                servico_online(item, "openvpnserv") and servico_online(item, "openvpnserv2")
            )
        ),
        "lojas": resultados,
    })


@app.route("/monitoramento/crm")
@login_required
def monitoramento_crm():
    return render_template("monitor_crm.html", usuario=session["user"])


def verificar_servidor_crm(servidor):
    ip = servidor["ip"]
    rede_online = ping_host(ip, timeout_ms=1200)
    dados = consultar_agente_crm(ip)
    base = {
        "nome": servidor["nome"],
        "ip": ip,
        "rede": "online" if (rede_online or dados is not None) else "offline",
        "agente": "online" if dados is not None else "offline",
        "hostname": "",
        "verificado_em": "",
        "uptime_segundos": None,
        "ultimo_reinicio": "",
        "cpu_percentual": None,
        "memoria_percentual": None,
        "disco_c_percentual": None,
        "disco_c_livre_gb": None,
        "crm_messok": "indisponivel",
        "crm_messok_instancias": 0,
    }
    if not dados:
        return base

    base["hostname"] = str(dados.get("hostname", "") or "").strip()
    base["verificado_em"] = str(dados.get("verificado_em", "") or "").strip()
    base["ultimo_reinicio"] = str(dados.get("ultimo_reinicio", "") or "").strip()
    for chave in ("uptime_segundos", "cpu_percentual", "memoria_percentual", "disco_c_percentual", "disco_c_livre_gb"):
        valor = dados.get(chave)
        if isinstance(valor, (int, float)) and not isinstance(valor, bool):
            base[chave] = max(0, valor)

    processo = dados.get("processo", {})
    if isinstance(processo, dict):
        status = normalizar(processo.get("status"))
        base["crm_messok"] = status if status in ("online", "offline") else "indisponivel"
        try:
            base["crm_messok_instancias"] = max(0, int(processo.get("instancias", 0) or 0))
        except (TypeError, ValueError):
            pass
    return base


@app.route("/api/crm")
@login_required
def api_crm():
    resultados = []
    with ThreadPoolExecutor(max_workers=len(SERVIDORES_CRM)) as executor:
        futuros = [executor.submit(verificar_servidor_crm, servidor) for servidor in SERVIDORES_CRM]
        for futuro in as_completed(futuros):
            try:
                resultados.append(futuro.result())
            except Exception as erro:
                logger.exception("Erro ao verificar servidor CRM: %s", erro)

    ordem = {item["ip"]: indice for indice, item in enumerate(SERVIDORES_CRM)}
    resultados.sort(key=lambda item: ordem.get(item["ip"], 999))
    servidores_offline = sum(1 for item in resultados if item["rede"] == "offline")
    processos_offline = sum(1 for item in resultados if item["agente"] == "online" and item["crm_messok"] != "online")
    return jsonify({
        "ultima_verificacao": now_str(),
        "total_servidores": len(resultados),
        "servidores_online": len(resultados) - servidores_offline,
        "servidores_offline": servidores_offline,
        "processos_online": sum(1 for item in resultados if item["crm_messok"] == "online"),
        "processos_offline": processos_offline,
        "servidores_alerta": sum(1 for item in resultados if item["rede"] == "offline" or item["crm_messok"] != "online"),
        "servidores": resultados,
    })


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    from waitress import serve

    os.makedirs(BASE_DIR, exist_ok=True)
    os.chdir(BASE_DIR)

    init_db()
    garantir_colunas_auditoria()

    serve(
        app,
        host=os.getenv("DASHBOARD_HOST", "127.0.0.1"),
        port=int(os.getenv("DASHBOARD_PORT", "5000")),
        threads=int(os.getenv("DASHBOARD_THREADS", "8")),
        channel_timeout=int(os.getenv("DASHBOARD_CHANNEL_TIMEOUT", "30")),
        max_request_body_size=app.config["MAX_CONTENT_LENGTH"],
        clear_untrusted_proxy_headers=True,
    )
