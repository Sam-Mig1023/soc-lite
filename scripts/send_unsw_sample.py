#!/usr/bin/env python3
"""Send one labeled UNSW-NB15 test flow to the SOC-Lite n8n webhook.

This utility intentionally sends one row per run. The prepared UNSW train/test
CSV does not include IP addresses, ports, or event timestamps, so those remain
absent. Its label is preserved in raw_payload.dataset_ground_truth.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "public" / "unsw-nb15" / "UNSW_NB15_testing-set.csv"
DEFAULT_WEBHOOK = "http://localhost:5678/webhook/soc-lite/unsw-nb15-alert"


def make_payload(row: dict[str, str]) -> dict:
    record_id = str(row.get("id", "")).strip()
    if not record_id:
        raise ValueError("La fila no tiene la columna 'id'.")

    label = int(row.get("label", "0"))
    attack_category = str(row.get("attack_cat", "Normal")).strip() or "Unknown"
    # Keep every model-visible alert field blind to the dataset label. The
    # ground truth is retained only in raw_payload for post-hoc evaluation.
    rule_level = 7
    severity = "medium"
    protocol = "unsw-nb15-hybrid-v3"
    event_id = f"unsw-nb15-hybrid-v3-testing-{record_id}"
    model_features = {
        key: value
        for key, value in row.items()
        if key not in {"id", "label", "attack_cat"}
    }

    return {
        "alert_fingerprint": f"unsw-nb15:hybrid-v3:testing:{record_id}",
        "external_id": event_id,
        "source_type": "api",
        "source_name": "UNSW-NB15 public dataset",
        "rule_id": "UNSW-NB15-FLOW",
        "rule_level": rule_level,
        "rule_description": "UNSW-NB15 network flow received for SOC analysis",
        "rule_groups": ["public-dataset", "unsw-nb15"],
        "severity": severity,
        "protocol": str(row.get("proto", "")).strip() or None,
        "agent_name": "unsw-nb15-dataset",
        "full_log": json.dumps(
            {
                "dataset": "UNSW-NB15",
                "features": model_features,
            },
            ensure_ascii=False,
        ),
        "raw_payload": {
            "dataset": "UNSW-NB15",
            "dataset_split": "testing-set",
            "evaluation_protocol": protocol,
            "dataset_record_id": record_id,
            "dataset_ground_truth": {
                "label": label,
                "attack_category": attack_category,
            },
            "features": row,
            "mapping_note": (
                "rule_level=7 is assigned by the SOC-Lite adapter so normal and attack "
                "examples both enter triage; it is not a value supplied by UNSW-NB15."
            ),
        },
    }


def find_rows(path: Path, selected_class: str, count: int, seed: int) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        required = {"id", "proto", "attack_cat", "label"}
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Faltan columnas requeridas en el CSV: {', '.join(sorted(missing))}")

        rows_by_class: dict[str, list[dict[str, str]]] = {"normal": [], "attack": []}
        for row in reader:
            is_attack = str(row.get("label", "0")).strip() == "1"
            rows_by_class["attack" if is_attack else "normal"].append(row)

    rng = random.Random(seed)
    classes = ("normal", "attack") if selected_class == "both" else (selected_class,)
    selected: list[dict[str, str]] = []
    for class_name in classes:
        available = rows_by_class[class_name]
        if not available:
            raise ValueError(f"No se encontraron filas de clase '{class_name}' en {path}.")
        selected.extend(rng.sample(available, min(count, len(available))))
    return selected


def post_payload(payload: dict, webhook: str) -> tuple[int, str]:
    request = Request(
        webhook,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=40) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def wait_for_triage(external_id: str, timeout_seconds: int, poll_seconds: float) -> str:
    """Wait for this alert's async triage before allowing the next sample to start."""
    query = (
        "SELECT COALESCE(t.model_name, 'PENDING') "
        "FROM soclite.alerts a "
        "LEFT JOIN soclite.triage_results t ON t.alert_id = a.id AND t.is_current "
        f"WHERE a.external_id = '{external_id}';"
    )
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            check = subprocess.run(
                [
                    "docker", "compose", "exec", "-T", "postgres", "psql",
                    "-U", "soclite", "-d", "soclite", "-A", "-t", "-c", query,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            time.sleep(min(poll_seconds, 5.0))
            continue
        if check.returncode != 0:
            raise RuntimeError(f"No se pudo consultar el estado de triaje: {check.stderr.strip()}")
        model_name = check.stdout.strip()
        if model_name and model_name != "PENDING":
            return model_name
        time.sleep(poll_seconds)
    raise TimeoutError(
        f"El triaje de {external_id} no terminó en {timeout_seconds} s; se detuvo el lote para no lanzar más alertas en paralelo."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--class", dest="selected_class", choices=("normal", "attack", "both"), default="normal")
    parser.add_argument(
        "--count",
        type=int,
        default=1,
        help="Filas por clase (si --class both, envía esta cantidad de cada clase).",
    )
    parser.add_argument("--seed", type=int, default=2026, help="Semilla para repetir la misma muestra aleatoria.")
    parser.add_argument("--triage-timeout", type=int, default=420, help="Máximo de espera por triaje antes de detener el lote.")
    parser.add_argument("--poll-seconds", type=float, default=5.0, help="Intervalo de consulta del estado de triaje.")
    parser.add_argument("--skip-first", type=int, default=0, help="Omitir las primeras N filas de la muestra para reanudar un lote.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--webhook", default=DEFAULT_WEBHOOK)
    args = parser.parse_args()

    if args.count < 1:
        parser.error("--count debe ser al menos 1")
    if args.triage_timeout < 1 or args.poll_seconds <= 0 or args.skip_first < 0:
        parser.error("--triage-timeout debe ser positivo, --poll-seconds mayor que cero y --skip-first no negativo")

    try:
        rows = find_rows(args.csv, args.selected_class, args.count, args.seed)
        if args.skip_first >= len(rows):
            raise ValueError(f"--skip-first ({args.skip_first}) debe ser menor que las {len(rows)} filas seleccionadas.")
        rows = rows[args.skip_first:]
        succeeded = 0
        duplicates = 0
        fallbacks = 0
        send_failures = 0
        for index, row in enumerate(rows):
            payload = make_payload(row)
            record_id = payload["raw_payload"]["dataset_record_id"]
            label = payload["raw_payload"]["dataset_ground_truth"]["label"]
            category = payload["raw_payload"]["dataset_ground_truth"]["attack_category"]
            try:
                status, response_body = post_payload(payload, args.webhook)
                result = json.loads(response_body)
                duplicated = bool(result.get("duplicated", False)) if isinstance(result, dict) else False
                external_id = payload["external_id"]
                model_name = wait_for_triage(external_id, args.triage_timeout, args.poll_seconds)
                is_fallback = model_name == "heuristic-fallback"
                state = "duplicado" if duplicated else "nuevo"
                print(
                    f"HTTP {status} · flow {record_id} · etiqueta real={label} ({category}) · "
                    f"{state} · modelo={model_name}",
                    flush=True,
                )
                if duplicated:
                    duplicates += 1
                elif is_fallback:
                    fallbacks += 1
                    print("El triaje terminó en contingencia; se detiene el lote para proteger las muestras siguientes.", flush=True)
                    break
                else:
                    succeeded += 1
            except HTTPError as error:
                body = error.read().decode("utf-8", errors="replace")
                print(f"Falló flow {record_id}: HTTP {error.code}: {body}", file=sys.stderr)
                send_failures += 1
                break
            except (OSError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as error:
                print(f"Falló flow {record_id}: {error}", file=sys.stderr)
                send_failures += 1
                break
        print(
            f"Terminado: {succeeded} triages nuevos con LLM, "
            f"{duplicates} duplicados, {fallbacks} contingencias y "
            f"{send_failures} fallas de envío/espera; "
            f"{len(rows) - succeeded - duplicates - fallbacks - send_failures} sin procesar."
        )
        print("Cada muestra se esperó antes de enviar la siguiente; las etiquetas quedaron fuera de los campos visibles al modelo.")
        return 1 if send_failures or fallbacks else 0
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"El webhook respondió HTTP {error.code}: {body}", file=sys.stderr)
    except (OSError, URLError, TimeoutError, RuntimeError, ValueError) as error:
        print(f"No se pudo enviar la muestra: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
