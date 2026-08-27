"""Gera uma CA local e um certificado TLS para o Dashboard Monitor."""

import ipaddress
import os
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from secret_store import carregar_ou_criar_segredo, restringir_acl


BASE_DIR = Path(__file__).resolve().parent
CERT_DIR = Path(os.getenv("DASHBOARD_CERT_DIR", str(BASE_DIR / "certs"))).resolve()
CA_KEY = CERT_DIR / "dashboard-ca.key"
CA_CERT = CERT_DIR / "dashboard-ca.crt"
SERVER_KEY = CERT_DIR / "dashboard-server.key"
SERVER_CERT = CERT_DIR / "dashboard-server.crt"
KEY_PASSWORD = BASE_DIR / ".tls_key_password.dpapi"


def nomes_e_ips_certificado():
    nomes = {"localhost"}
    ips = {ipaddress.ip_address("127.0.0.1")}

    for nome in (socket.gethostname(), socket.getfqdn()):
        if nome and nome.lower() != "localhost":
            nomes.add(nome.lower())

    extras = os.getenv("DASHBOARD_CERT_HOSTS", "")
    for item in extras.split(","):
        valor = item.strip().lower()
        if not valor:
            continue
        try:
            ips.add(ipaddress.ip_address(valor))
        except ValueError:
            nomes.add(valor)

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            endereco = ipaddress.ip_address(info[4][0])
            if endereco.is_private or endereco.is_loopback:
                ips.add(endereco)
    except OSError:
        pass

    return nomes, ips


def proteger_chave(caminho):
    restringir_acl(caminho)


def gravar_chave(caminho, chave, senha):
    caminho.write_bytes(
        chave.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.BestAvailableEncryption(senha),
        )
    )
    proteger_chave(caminho)


def carregar_chave_privada(caminho, senha):
    dados = caminho.read_bytes()
    if b"BEGIN ENCRYPTED PRIVATE KEY" in dados:
        chave = serialization.load_pem_private_key(dados, password=senha)
    else:
        chave = serialization.load_pem_private_key(dados, password=None)
        gravar_chave(caminho, chave, senha)
    return chave


def certificado_atual_valido(nomes, ips, senha):
    if not all(p.exists() for p in (CA_KEY, CA_CERT, SERVER_KEY, SERVER_CERT)):
        return False
    try:
        certificado_ca = x509.load_pem_x509_certificate(CA_CERT.read_bytes())
        certificado = x509.load_pem_x509_certificate(SERVER_CERT.read_bytes())
        chave = carregar_chave_privada(SERVER_KEY, senha)
        if certificado.not_valid_after_utc <= datetime.now(timezone.utc) + timedelta(days=30):
            return False
        if certificado.issuer != certificado_ca.subject:
            return False
        if chave.public_key().public_numbers() != certificado.public_key().public_numbers():
            return False
        certificado_ca.public_key().verify(
            certificado.signature,
            certificado.tbs_certificate_bytes,
            padding.PKCS1v15(),
            certificado.signature_hash_algorithm,
        )
        certificado.extensions.get_extension_for_class(x509.SubjectKeyIdentifier)
        certificado.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier)
        sans = certificado.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        nomes_atuais = {n.lower() for n in sans.get_values_for_type(x509.DNSName)}
        ips_atuais = set(sans.get_values_for_type(x509.IPAddress))
        return nomes <= nomes_atuais and ips <= ips_atuais
    except (OSError, ValueError, TypeError, InvalidSignature, x509.ExtensionNotFound):
        return False


def carregar_ou_criar_ca(agora, senha):
    if CA_KEY.exists() and CA_CERT.exists():
        try:
            chave = carregar_chave_privada(CA_KEY, senha)
            certificado = x509.load_pem_x509_certificate(CA_CERT.read_bytes())
            certificado.extensions.get_extension_for_class(x509.SubjectKeyIdentifier)
            if certificado.not_valid_after_utc > agora + timedelta(days=397):
                proteger_chave(CA_KEY)
                return chave, certificado
        except (OSError, ValueError, TypeError, x509.ExtensionNotFound):
            pass

    chave = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Dashboard Monitor Local CA")])
    certificado = (
        x509.CertificateBuilder()
        .subject_name(nome)
        .issuer_name(nome)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - timedelta(minutes=5))
        .not_valid_after(agora + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(chave.public_key()), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=False,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(chave, hashes.SHA256())
    )
    gravar_chave(CA_KEY, chave, senha)
    CA_CERT.write_bytes(certificado.public_bytes(serialization.Encoding.PEM))
    return chave, certificado


def garantir_certificado():
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    senha = carregar_ou_criar_segredo(
        KEY_PASSWORD, 48, "Senha das chaves TLS do Dashboard"
    )
    # Converte chaves antigas sem senha antes de validar o certificado atual.
    for caminho_chave in (CA_KEY, SERVER_KEY):
        if caminho_chave.exists():
            carregar_chave_privada(caminho_chave, senha)
    nomes, ips = nomes_e_ips_certificado()
    if certificado_atual_valido(nomes, ips, senha):
        proteger_chave(CA_KEY)
        proteger_chave(SERVER_KEY)
        return SERVER_CERT, SERVER_KEY, CA_CERT, senha

    agora = datetime.now(timezone.utc)
    chave_ca, certificado_ca = carregar_ou_criar_ca(agora, senha)
    chave = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    assunto = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Dashboard Monitor")])
    sans = [x509.DNSName(nome) for nome in sorted(nomes)]
    sans.extend(x509.IPAddress(endereco) for endereco in sorted(ips, key=str))
    certificado = (
        x509.CertificateBuilder()
        .subject_name(assunto)
        .issuer_name(certificado_ca.subject)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - timedelta(minutes=5))
        .not_valid_after(agora + timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(chave.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(chave_ca.public_key()), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(chave_ca, hashes.SHA256())
    )
    gravar_chave(SERVER_KEY, chave, senha)
    SERVER_CERT.write_bytes(certificado.public_bytes(serialization.Encoding.PEM))
    return SERVER_CERT, SERVER_KEY, CA_CERT, senha


if __name__ == "__main__":
    certificado, _, ca, _ = garantir_certificado()
    print(f"Certificado do servidor: {certificado}")
    print(f"Certificado público da CA: {ca}")
