"""Camada de banco compatível com MySQL e SQLite.

O backend padrão é MySQL. SQLite permanece disponível apenas para testes,
recuperação e migração usando DASHBOARD_DB_BACKEND=sqlite.
"""

import os
import re
import sqlite3
from pathlib import Path
from threading import Lock

from secret_store import ler_segredo, migrar_segredo_texto


DB_BACKEND = os.getenv("DASHBOARD_DB_BACKEND", "mysql").strip().lower()
if DB_BACKEND not in {"mysql", "sqlite"}:
    raise RuntimeError("DASHBOARD_DB_BACKEND deve ser 'mysql' ou 'sqlite'.")

BASE_DIR = os.getenv("DASHBOARD_BASE_DIR", r"C:\dashboard_monitor")
DB_PATH = os.getenv("DASHBOARD_DB_PATH", os.path.join(BASE_DIR, "monitor.db"))

mysql_connector = None
mysql_errors = None
MySQLConnectionPool = None
if DB_BACKEND == "mysql":
    try:
        import mysql.connector as mysql_connector
        from mysql.connector import errors as mysql_errors
        from mysql.connector.pooling import MySQLConnectionPool
    except ImportError as exc:
        raise RuntimeError(
            "Driver MySQL ausente. Execute: python -m pip install -r requirements.txt"
        ) from exc


DB_INTEGRITY_ERRORS = (
    (sqlite3.IntegrityError, mysql_errors.IntegrityError)
    if mysql_errors is not None else (sqlite3.IntegrityError,)
)


def env_bool(nome, padrao=False):
    return os.getenv(nome, str(padrao)).strip().lower() in {"1", "true", "yes", "sim", "on"}


def _segredo_mysql():
    senha = os.getenv("MYSQL_PASSWORD", "")
    if senha:
        raise RuntimeError(
            "MYSQL_PASSWORD em texto simples não é aceita; use MYSQL_PASSWORD_FILE com DPAPI."
        )
    arquivo_padrao = Path(BASE_DIR) / ".mysql_password.dpapi"
    arquivo_antigo = Path(BASE_DIR) / ".mysql_password"
    arquivo_configurado = os.getenv("MYSQL_PASSWORD_FILE", "").strip()
    arquivo = arquivo_configurado or str(arquivo_padrao)
    if arquivo:
        caminho = Path(arquivo).resolve()
        try:
            if caminho == arquivo_padrao.resolve():
                valor = migrar_segredo_texto(
                    arquivo_antigo, caminho, "Senha do MySQL do Dashboard"
                )
                if valor is None:
                    valor = ler_segredo(caminho)
            else:
                valor = ler_segredo(caminho)
            senha = valor.decode("utf-8").strip()
        except (OSError, UnicodeError, RuntimeError) as exc:
            raise RuntimeError("Não foi possível ler MYSQL_PASSWORD_FILE.") from exc
    if not senha:
        raise RuntimeError("Defina MYSQL_PASSWORD ou MYSQL_PASSWORD_FILE.")
    return senha


class DatabaseRow(dict):
    """Mantém acesso por nome e por posição, como sqlite3.Row."""

    def __getitem__(self, chave):
        if isinstance(chave, int):
            try:
                return tuple(self.values())[chave]
            except IndexError as exc:
                raise IndexError(chave) from exc
        return super().__getitem__(chave)


def _traduzir_parametros(sql):
    # As consultas do projeto não possuem '?' literais; todos são marcadores.
    return sql.replace("?", "%s")


class CursorMySQL:
    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, sql, parametros=None):
        self._cursor.execute(_traduzir_parametros(sql), tuple(parametros or ()))
        return self

    def executemany(self, sql, sequencia):
        self._cursor.executemany(_traduzir_parametros(sql), sequencia)
        return self

    def fetchone(self):
        linha = self._cursor.fetchone()
        return DatabaseRow(linha) if linha is not None else None

    def fetchall(self):
        return [DatabaseRow(linha) for linha in self._cursor.fetchall()]

    @property
    def lastrowid(self):
        return self._cursor.lastrowid

    @property
    def rowcount(self):
        return self._cursor.rowcount

    def close(self):
        self._cursor.close()


class ConexaoMySQL:
    def __init__(self, conexao):
        self._conexao = conexao

    def cursor(self):
        return CursorMySQL(self._conexao.cursor(dictionary=True, buffered=True))

    def execute(self, sql, parametros=None):
        return self.cursor().execute(sql, parametros)

    def commit(self):
        self._conexao.commit()

    def rollback(self):
        self._conexao.rollback()

    def close(self):
        self._conexao.close()


_pool = None
_pool_lock = Lock()


def _configuracao_mysql():
    host = os.getenv("MYSQL_HOST", "127.0.0.1").strip()
    banco = os.getenv("MYSQL_DATABASE", "dashboard_monitor").strip()
    usuario = os.getenv("MYSQL_USER", "dashboard_app").strip()
    if not host or not banco or not usuario:
        raise RuntimeError("MYSQL_HOST, MYSQL_DATABASE e MYSQL_USER são obrigatórios.")
    if not re.fullmatch(r"[A-Za-z0-9_$-]{1,64}", banco):
        raise RuntimeError("MYSQL_DATABASE contém caracteres inválidos.")

    configuracao = {
        "host": host,
        "port": int(os.getenv("MYSQL_PORT", "3307")),
        "database": banco,
        "user": usuario,
        "password": _segredo_mysql(),
        "charset": "utf8mb4",
        "collation": "utf8mb4_0900_ai_ci",
        "autocommit": False,
        "connection_timeout": int(os.getenv("MYSQL_CONNECT_TIMEOUT", "10")),
        "ssl_disabled": not env_bool("MYSQL_SSL_REQUIRED", True),
    }
    ca = os.getenv("MYSQL_SSL_CA", "").strip()
    if ca:
        caminho_ca = str(Path(ca).resolve())
        if not Path(caminho_ca).is_file():
            raise RuntimeError("MYSQL_SSL_CA não aponta para um arquivo válido.")
        configuracao.update({
            "ssl_ca": caminho_ca,
            "ssl_verify_cert": True,
            "ssl_verify_identity": True,
        })
    elif host not in {"127.0.0.1", "localhost", "::1"} and env_bool("MYSQL_SSL_REQUIRED", True):
        raise RuntimeError("Conexão MySQL remota exige MYSQL_SSL_CA para validar o servidor.")
    return configuracao


def _obter_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                tamanho = min(32, max(1, int(os.getenv("MYSQL_POOL_SIZE", "8"))))
                _pool = MySQLConnectionPool(
                    pool_name="dashboard_monitor_pool",
                    pool_size=tamanho,
                    pool_reset_session=True,
                    **_configuracao_mysql(),
                )
    return _pool


def get_db():
    if DB_BACKEND == "sqlite":
        os.makedirs(os.path.dirname(DB_PATH) or BASE_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 15000")
        return conn
    return ConexaoMySQL(_obter_pool().get_connection())


def criar_schema(conn):
    cur = conn.cursor()
    if DB_BACKEND == "sqlite":
        cur.execute("""
            CREATE TABLE IF NOT EXISTS lojas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL UNIQUE,
                ip TEXT NOT NULL UNIQUE,
                observacao TEXT,
                criado_por TEXT,
                criado_em TEXT NOT NULL,
                alterado_por TEXT,
                alterado_em TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS caixas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loja_id INTEGER NOT NULL,
                nome TEXT NOT NULL,
                ip TEXT,
                status TEXT DEFAULT 'offline',
                observacao TEXT,
                criado_por TEXT,
                criado_em TEXT NOT NULL,
                alterado_por TEXT,
                alterado_em TEXT,
                FOREIGN KEY (loja_id) REFERENCES lojas(id)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_caixas_loja_nome
            ON caixas (loja_id, nome, id)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                usuario TEXT NOT NULL UNIQUE,
                senha_hash TEXT NOT NULL,
                permissoes TEXT NOT NULL DEFAULT '[]',
                administrador INTEGER NOT NULL DEFAULT 0,
                ativo INTEGER NOT NULL DEFAULT 1,
                sessao_versao INTEGER NOT NULL DEFAULT 1,
                criado_em TEXT NOT NULL,
                alterado_em TEXT,
                alterado_por TEXT,
                senha_alterada_em TEXT
            )
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS lojas (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                nome VARCHAR(80) NOT NULL,
                ip VARCHAR(45) NOT NULL,
                observacao VARCHAR(500) NULL,
                criado_por VARCHAR(80) NULL,
                criado_em VARCHAR(19) NOT NULL,
                alterado_por VARCHAR(80) NULL,
                alterado_em VARCHAR(19) NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_lojas_nome (nome),
                UNIQUE KEY uq_lojas_ip (ip)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS caixas (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                loja_id INT UNSIGNED NOT NULL,
                nome VARCHAR(80) NOT NULL,
                ip VARCHAR(45) NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'offline',
                observacao VARCHAR(500) NULL,
                criado_por VARCHAR(80) NULL,
                criado_em VARCHAR(19) NOT NULL,
                alterado_por VARCHAR(80) NULL,
                alterado_em VARCHAR(19) NULL,
                PRIMARY KEY (id),
                KEY idx_caixas_loja_nome (loja_id, nome, id),
                CONSTRAINT fk_caixas_lojas FOREIGN KEY (loja_id)
                    REFERENCES lojas (id) ON DELETE CASCADE ON UPDATE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                nome VARCHAR(80) NOT NULL,
                usuario VARCHAR(40) NOT NULL,
                senha_hash VARCHAR(512) NOT NULL,
                permissoes TEXT NOT NULL,
                administrador TINYINT(1) NOT NULL DEFAULT 0,
                ativo TINYINT(1) NOT NULL DEFAULT 1,
                sessao_versao INT UNSIGNED NOT NULL DEFAULT 1,
                criado_em VARCHAR(19) NOT NULL,
                alterado_em VARCHAR(19) NULL,
                alterado_por VARCHAR(80) NULL,
                senha_alterada_em VARCHAR(19) NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_usuarios_usuario (usuario),
                CONSTRAINT chk_usuarios_administrador CHECK (administrador IN (0, 1)),
                CONSTRAINT chk_usuarios_ativo CHECK (ativo IN (0, 1))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        """)


def coluna_existe(conn, tabela, coluna):
    if tabela not in {"lojas", "caixas", "usuarios"}:
        raise ValueError("Tabela inválida.")
    cur = conn.cursor()
    if DB_BACKEND == "sqlite":
        cur.execute(f"PRAGMA table_info({tabela})")
        return coluna in [row["name"] for row in cur.fetchall()]
    cur.execute("""
        SELECT COUNT(*) AS total
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s AND column_name = %s
    """, (os.getenv("MYSQL_DATABASE", "dashboard_monitor"), tabela, coluna))
    return bool(cur.fetchone()["total"])
