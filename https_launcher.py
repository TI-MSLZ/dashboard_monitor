"""Servidor HTTPS de produção do Dashboard Monitor."""

import os
import ssl

os.environ["DASHBOARD_HTTPS_ONLY"] = "true"
os.environ["DASHBOARD_BEHIND_PROXY"] = "false"

from cheroot.ssl.builtin import BuiltinSSLAdapter
from cheroot.wsgi import Server

from app import app, garantir_colunas_auditoria, init_db
from tls_certificate import garantir_certificado


def main():
    host = os.getenv("DASHBOARD_HTTPS_BIND", "127.0.0.1").strip() or "127.0.0.1"
    porta = int(os.getenv("DASHBOARD_HTTPS_PORT", "5443"))
    if not 1 <= porta <= 65535:
        raise ValueError("DASHBOARD_HTTPS_PORT deve estar entre 1 e 65535.")

    certificado, chave, _, senha_chave = garantir_certificado()
    init_db()
    garantir_colunas_auditoria()

    servidor = Server(
        (host, porta),
        app,
        numthreads=max(2, int(os.getenv("DASHBOARD_THREADS", "8"))),
    )
    adaptador_tls = BuiltinSSLAdapter(
        str(certificado), str(chave), private_key_password=senha_chave
    )
    adaptador_tls.context.minimum_version = ssl.TLSVersion.TLSv1_2
    servidor.ssl_adapter = adaptador_tls

    try:
        servidor.prepare()
    except OSError as exc:
        if getattr(exc, "winerror", None) == 10048:
            raise RuntimeError(
                f"A porta {porta} ja esta em uso. O Dashboard pode ja estar aberto."
            ) from exc
        raise

    endereco_exibido = (
        "localhost" if host in {"127.0.0.1", "::1", "0.0.0.0", "::"} else host
    )
    print(f"Dashboard HTTPS iniciado em https://{endereco_exibido}:{porta}", flush=True)
    try:
        servidor.serve()
    except KeyboardInterrupt:
        pass
    finally:
        if servidor.ready:
            servidor.stop()


if __name__ == "__main__":
    main()
