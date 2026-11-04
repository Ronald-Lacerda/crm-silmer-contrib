"""Offline structural probe for OLIST-T02. Not an ERP adapter or live proof."""
import copy
import hashlib
import json
import unittest
from fractions import Fraction
from pathlib import Path

from jsonschema import Draft4Validator

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "evidence/schema-manifest.json").read_text(encoding="utf-8"))
RAW = (ROOT / "evidence" / MANIFEST["projectionFile"]).read_bytes()
SCHEMA = json.loads(RAW)
FIXTURES = json.loads((ROOT / "fixtures.json").read_text(encoding="utf-8"))


def oas_nullable(node):
    """Adapt OAS3 nullable to JSON Schema; preserve references, types and allOf."""
    if isinstance(node, list):
        return [oas_nullable(value) for value in node]
    if not isinstance(node, dict):
        return node
    result = {key: oas_nullable(value) for key, value in node.items() if key != "nullable"}
    return {"anyOf": [{"type": "null"}, result]} if node.get("nullable") else result


def validator(name):
    document = oas_nullable(SCHEMA)
    document["$ref"] = "#/components/schemas/" + name
    return Draft4Validator(document)


def properties(name):
    """Inspect inherited properties only, not a replacement for schema validation."""
    def collect(node):
        if "$ref" in node:
            return collect(SCHEMA["components"]["schemas"][node["$ref"].split("/")[-1]])
        result = dict(node.get("properties", {}))
        for part in node.get("allOf", []):
            result.update(collect(part))
        return result
    return collect(SCHEMA["components"]["schemas"][name])


def represented_unit(quantity, subtotal_cents, scale):
    """Hypothesis only: integer scale and half-up rounding on each line.

    Try adjacent unit values with rational arithmetic, never binary floats.
    No selected scale/rounding is asserted as Olist behavior.
    """
    if type(quantity) is not int or quantity <= 0:
        raise ValueError("Invalid quantity")
    if type(subtotal_cents) is not int or subtotal_cents <= 0:
        raise ValueError("Invalid subtotal")
    if type(scale) is not int or not 0 <= scale <= 8:
        raise ValueError("Invalid hypothesis scale")
    factor = 10 ** scale
    ideal = Fraction(subtotal_cents * factor, quantity * 100)
    floor = ideal.numerator // ideal.denominator
    for unit in (floor, floor + 1):
        if unit <= 0:
            continue
        cents = Fraction(unit * quantity * 100, factor)
        rounded = (2 * cents.numerator + cents.denominator) // (2 * cents.denominator)
        if rounded == subtotal_cents:
            return unit
    return None


class ContractProbe(unittest.TestCase):
    def test_manifest_and_local_reference_closure(self):
        self.assertEqual(hashlib.sha256(RAW).hexdigest(), MANIFEST["projectionSha256"])
        self.assertEqual(SCHEMA["openapi"], "3.0.0")
        self.assertEqual(SCHEMA["info"]["version"], MANIFEST["apiVersion"])
        self.assertEqual(MANIFEST["accountCalls"], 0)
        self.assertFalse(MANIFEST["liveProven"])
        self.assertEqual(
            {path: sorted(methods) for path, methods in SCHEMA["paths"].items()},
            {path: sorted(methods) for path, methods in MANIFEST["operations"].items()},
        )
        def visit(node):
            if isinstance(node, list):
                for value in node:
                    visit(value)
            elif isinstance(node, dict):
                if "$ref" in node:
                    self.assertTrue(node["$ref"].startswith("#/components/"))
                    resolved = SCHEMA
                    for token in node["$ref"].split("/")[1:]:
                        resolved = resolved[token]
                for value in node.values():
                    visit(value)
        visit(SCHEMA)

    def test_structural_request_fixtures(self):
        for fixture, name in {
            "contact": "CriarContatoModelRequest",
            "parent": "CriarProdutoRequestModel",
            "variation": "VariacaoProdutoRequestModel",
            "order": "CriarPedidoModelRequest",
        }.items():
            with self.subTest(fixture=fixture):
                validator(name).validate(FIXTURES["requests"][fixture])
        self.assertFalse(FIXTURES["sendable"])
        # Schema accepts an intentionally invalid fiscal document: NOT fiscal proof.
        self.assertEqual(FIXTURES["requests"]["contact"]["cpfCnpj"], "00000000000")

    def test_schema_rejects_product_missing_sku_and_invalid_type(self):
        for key, replacement in (("sku", None), ("tipo", "INVALID")):
            product = copy.deepcopy(FIXTURES["requests"]["parent"])
            if replacement is None:
                del product[key]
            else:
                product[key] = replacement
            self.assertFalse(validator("CriarProdutoRequestModel").is_valid(product))

    def test_schema_permissiveness_is_an_open_gap(self):
        # Missing required business data passes the published structural schema.
        for name in ("CriarContatoModelRequest", "CriarPedidoModelRequest", "VariacaoProdutoRequestModel"):
            with self.subTest(name=name):
                self.assertTrue(validator(name).is_valid({}))
        parent = {"sku": "synthetic", "descricao": "Synthetic", "tipo": "V"}
        self.assertTrue(validator("CriarProdutoRequestModel").is_valid(parent))
        self.assertIn("Obrigat", properties("CriarProdutoRequestModel")["grade"]["description"])
        # Validation above does not enforce the documented conditional requirement.

    def test_money_scale_and_line_subtotal_are_not_declared(self):
        for name in ("ItemPedidoRequestModel", "ItemPedidoResponseModel"):
            unit = properties(name)["valorUnitario"]
            self.assertEqual(unit["type"], "number")
            self.assertEqual(unit["format"], "float")
            self.assertNotIn("multipleOf", unit)
        self.assertNotIn("subtotal", properties("ItemPedidoResponseModel"))
        self.assertNotIn("valorTotal", properties("ItemPedidoResponseModel"))

    def test_exact_rational_money_hypotheses(self):
        for case in FIXTURES["money"]:
            with self.subTest(case=case["id"]):
                result = represented_unit(case["quantity"], case["subtotalCents"], case["scale"])
                self.assertEqual(result is not None, case["representable"])

    def test_invalid_money_inputs(self):
        for args in ((0, 100, 2), (-1, 100, 2), (1.5, 100, 2), (1, 0, 2), (1, -1, 2), (1, 1.5, 2), (True, 100, 2)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                represented_unit(*args)

    def test_equal_total_cannot_prove_line_equality(self):
        case = FIXTURES["readback"]
        self.assertEqual(sum(case["expectedLineCents"]), sum(case["remoteLineCents"]))
        self.assertNotEqual(case["expectedLineCents"], case["remoteLineCents"])
        self.assertEqual(case["expectedTotalCents"], case["remoteTotalCents"])

    def test_same_size_in_distinct_groups_keeps_identity(self):
        first, second = FIXTURES["groupIdentity"]
        self.assertEqual(first["size"], second["size"])
        for key in ("groupId", "lineId", "productId"):
            self.assertNotEqual(first[key], second[key])

    def test_recovery_matrix_is_complete_not_a_runtime_test(self):
        cases = FIXTURES["recovery"]
        self.assertEqual(len(cases), 24)
        self.assertEqual(len({(case["entity"], case["fault"]) for case in cases}), 24)
        for case in cases:
            self.assertEqual(case["expected"], "outcome_unknown")
            self.assertFalse(case["nextCreationAllowed"])
            self.assertFalse(case["dependentCreationAllowed"])
        # This checks the planned cases, never the unimplemented worker behavior.

    def test_documented_lookup_filters_and_parent_readback(self):
        for path, required in {
            "/contatos": {"cpfCnpj", "codigo", "limit", "offset"},
            "/produtos": {"codigo", "limit", "offset"},
            "/pedidos": {"numeroPedidoEcommerce", "limit", "offset"},
        }.items():
            actual = set()
            for param in SCHEMA["paths"][path]["get"]["parameters"]:
                resolved = SCHEMA
                for token in param["$ref"].split("/")[1:]:
                    resolved = resolved[token]
                actual.add(resolved["name"])
            self.assertTrue(required <= actual)
        for key in ("produtoPai", "variacoes"):
            self.assertIn(key, properties("ObterProdutoModelResponse"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
