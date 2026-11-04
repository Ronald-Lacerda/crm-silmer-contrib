"""OLIST-T02: capture only public documentation; never connects to an ERP account."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SOURCE_URL = "https://erp.olist.com/public-api/v3/swagger/swagger-mintlify.json"
OPERATIONS = {
    "/info": ["get"],
    "/contatos": ["get", "post"],
    "/contatos/{idContato}": ["get"],
    "/produtos": ["get", "post"],
    "/produtos/{idProduto}": ["get"],
    "/produtos/{idProduto}/variacoes": ["post"],
    "/pedidos": ["get", "post"],
    "/pedidos/{idPedido}": ["get"],
}


def project(source):
    """Preserve selected operations and the transitive closure of local references."""
    result = {key: source[key] for key in ("openapi", "info", "servers", "security") if key in source}
    result["paths"] = {
        path: {method: source["paths"][path][method] for method in methods}
        for path, methods in OPERATIONS.items()
    }
    result["components"] = {}
    pending = [result["paths"]]
    while pending:
        node = pending.pop()
        if isinstance(node, list):
            pending.extend(node)
        elif isinstance(node, dict):
            pending.extend(node.values())
            if "$ref" in node:
                ref = node["$ref"]
                if not ref.startswith("#/components/"):
                    raise ValueError("Nonlocal reference; review required")
                _, _, group, name = ref.split("/")
                bucket = result["components"].setdefault(group, {})
                if name not in bucket:
                    bucket[name] = source["components"][group][name]
                    pending.append(bucket[name])
    return result


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


if __name__ == "__main__":
    with urlopen(SOURCE_URL, timeout=30) as response:
        if response.geturl() != SOURCE_URL:
            raise ValueError("Unexpected redirect; review required")
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Schema exceeds capture limit")
        last_modified = response.headers.get("Last-Modified")
    source = json.loads(raw)
    projection = encode(project(source))
    manifest = {
        "task": "OLIST-T02",
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": SOURCE_URL,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "sourceBytes": len(raw),
        "sourceLastModified": last_modified,
        "openapi": source["openapi"],
        "apiVersion": source["info"]["version"],
        "projectionFile": "openapi-v3.projection.json",
        "projectionSha256": hashlib.sha256(projection).hexdigest(),
        "projectionRule": "Selected operations plus unchanged transitive local components; sorted UTF-8 JSON with LF.",
        "operations": OPERATIONS,
        "accountCalls": 0,
        "liveProven": False,
    }
    evidence = ROOT / "evidence"
    evidence.mkdir(exist_ok=True)
    (evidence / manifest["projectionFile"]).write_bytes(projection)
    (evidence / "schema-manifest.json").write_bytes(encode(manifest))
    print(json.dumps({key: manifest[key] for key in ("apiVersion", "sourceSha256", "projectionSha256", "accountCalls")}))
