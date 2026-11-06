"""Inferencia opcional del clasificador binario entrenado con UNSW-NB15."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import joblib
import pandas as pd

from app.core.config import settings

CATEGORICAL_COLUMNS = {"proto", "service", "state"}


@lru_cache(maxsize=2)
def _load_bundle(model_path: str) -> dict[str, Any] | None:
    path = Path(model_path)
    if not path.is_file():
        return None
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or "pipeline" not in bundle or "feature_columns" not in bundle:
        raise ValueError(f"Artefacto de clasificador UNSW inválido: {path}")
    return bundle


def predict_unsw_flow(features: dict[str, Any]) -> dict[str, Any] | None:
    """Devuelve etiqueta/probabilidad, o None si aún no se instaló el artefacto."""
    bundle = _load_bundle(settings.UNSW_CLASSIFIER_MODEL_PATH)
    if bundle is None:
        return None

    columns: list[str] = bundle["feature_columns"]
    values = {column: features.get(column) for column in columns}
    frame = pd.DataFrame([values], columns=columns)
    for column in columns:
        if column in CATEGORICAL_COLUMNS:
            frame[column] = frame[column].fillna("Unknown").astype(str)
        else:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")

    pipeline = bundle["pipeline"]
    class_index = list(pipeline.classes_).index(1)
    attack_probability = float(pipeline.predict_proba(frame)[0][class_index])
    decision_threshold = float(bundle.get("decision_threshold", 0.5))
    predicted_label = int(attack_probability >= decision_threshold)
    return {
        "predicted_label": predicted_label,
        "predicted_class": "attack" if predicted_label == 1 else "normal",
        "attack_probability": attack_probability,
        "decision_threshold": decision_threshold,
        "model_name": bundle.get("model_name", "UNSW-NB15 Random Forest"),
    }
