"""Armazenamento de segredos protegido pelo DPAPI do Windows."""

import os
import secrets
import subprocess
from pathlib import Path

import win32crypt


_ENTROPIA = b"DashboardMonitor|DPAPI|v1"
# Valores definidos pela API Win32; algumas versões do pywin32 não exportam
# os nomes das constantes, embora exponham CryptProtectData/UnprotectData.
_CRYPTPROTECT_UI_FORBIDDEN = 0x1
_CRYPTPROTECT_LOCAL_MACHINE = 0x4
_FLAGS = _CRYPTPROTECT_LOCAL_MACHINE | _CRYPTPROTECT_UI_FORBIDDEN
_MARCADOR_DESATIVADO = b"DASHBOARD-DPAPI-RETIRED\x00"


def restringir_acl(caminho):
    """Restringe o arquivo ao usuário atual, SYSTEM e Administradores."""
    caminho = Path(caminho).resolve()
    try:
        caminho.chmod(0o600)
    except OSError:
        pass
    if os.name != "nt":
        return

    usuario = os.getenv("USERNAME", "").strip()
    dominio = os.getenv("USERDOMAIN", "").strip()
    identidade = f"{dominio}\\{usuario}" if dominio and usuario else usuario
    comando = ["icacls", str(caminho), "/inheritance:r"]
    if identidade:
        comando.extend(["/grant:r", f"{identidade}:(R,W)"])
    comando.extend(["/grant:r", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"])
    resultado = subprocess.run(
        comando,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if resultado.returncode != 0:
        raise RuntimeError(f"Não foi possível restringir a ACL de {caminho.name}.")


def proteger_segredo(valor, descricao="Dashboard Monitor"):
    if not isinstance(valor, bytes) or not valor:
        raise ValueError("O segredo deve ser bytes e não pode estar vazio.")
    return win32crypt.CryptProtectData(valor, descricao, _ENTROPIA, None, None, _FLAGS)


def revelar_segredo(blob):
    try:
        _, valor = win32crypt.CryptUnprotectData(blob, _ENTROPIA, None, None, _FLAGS)
    except Exception as exc:
        raise RuntimeError(
            "Não foi possível descriptografar o segredo com o DPAPI desta máquina."
        ) from exc
    if not valor:
        raise RuntimeError("O segredo protegido está vazio.")
    return valor


def gravar_segredo(caminho, valor, descricao="Dashboard Monitor"):
    caminho = Path(caminho).resolve()
    caminho.parent.mkdir(parents=True, exist_ok=True)
    temporario = caminho.with_name(f".{caminho.name}.{os.getpid()}.tmp")
    temporario.write_bytes(proteger_segredo(valor, descricao))
    os.replace(temporario, caminho)
    restringir_acl(caminho)
    if revelar_segredo(caminho.read_bytes()) != valor:
        raise RuntimeError(f"Falha ao verificar o segredo protegido {caminho.name}.")


def ler_segredo(caminho):
    caminho = Path(caminho).resolve()
    try:
        blob = caminho.read_bytes()
    except OSError as exc:
        raise RuntimeError(f"Não foi possível ler {caminho.name}.") from exc
    restringir_acl(caminho)
    return revelar_segredo(blob)


def carregar_ou_criar_segredo(caminho, quantidade=64, descricao="Dashboard Monitor"):
    caminho = Path(caminho).resolve()
    if caminho.exists():
        return ler_segredo(caminho)
    valor = secrets.token_urlsafe(quantidade).encode("ascii")
    gravar_segredo(caminho, valor, descricao)
    return valor


def remover_texto_simples(caminho):
    """Sobrescreve e remove um arquivo após a cópia protegida ser verificada."""
    caminho = Path(caminho).resolve()
    if not caminho.exists():
        return
    tamanho = caminho.stat().st_size
    if tamanho:
        with caminho.open("r+b", buffering=0) as arquivo:
            arquivo.write(secrets.token_bytes(tamanho))
            arquivo.flush()
            os.fsync(arquivo.fileno())
    if os.name == "nt":
        usuario = os.getenv("USERNAME", "").strip()
        dominio = os.getenv("USERDOMAIN", "").strip()
        identidade = f"{dominio}\\{usuario}" if dominio and usuario else usuario
        if identidade:
            subprocess.run(
                ["icacls", str(caminho), "/grant:r", f"{identidade}:(F)"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    try:
        caminho.unlink()
    except PermissionError:
        # ACLs legadas podem permitir sobrescrita, mas reservar a exclusão ao
        # grupo Administradores. Nesse caso, deixa apenas um blob DPAPI inútil.
        descarte = proteger_segredo(
            secrets.token_bytes(max(32, tamanho)), "Arquivo de segredo desativado"
        )
        caminho.write_bytes(_MARCADOR_DESATIVADO + descarte)


def migrar_segredo_texto(caminho_antigo, caminho_protegido, descricao):
    antigo = Path(caminho_antigo).resolve()
    protegido = Path(caminho_protegido).resolve()
    if protegido.exists():
        valor = ler_segredo(protegido)
        if antigo.exists():
            if not antigo.read_bytes().startswith(_MARCADOR_DESATIVADO):
                remover_texto_simples(antigo)
        return valor
    if not antigo.exists():
        return None
    valor = antigo.read_bytes().strip()
    if not valor:
        raise RuntimeError(f"O segredo em {antigo.name} está vazio.")
    gravar_segredo(protegido, valor, descricao)
    if ler_segredo(protegido) != valor:
        raise RuntimeError(f"Falha ao verificar a migração de {antigo.name}.")
    remover_texto_simples(antigo)
    return valor
