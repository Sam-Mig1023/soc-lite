#!/usr/bin/env python3
"""Train and evaluate a leakage-safe UNSW-NB15 binary classifier.

Fits only on UNSW_NB15_training-set.csv and reports metrics on the official
UNSW_NB15_testing-set.csv. The target columns and record identifier are never
used as features. The fitted pipeline is saved locally for optional inference.
"""
from __future__ import annotations

import argparse
import json
import platform
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    precision_recall_curve,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "public" / "unsw-nb15"
TRAIN_DEFAULT = DATA_DIR / "UNSW_NB15_training-set.csv"
TEST_DEFAULT = DATA_DIR / "UNSW_NB15_testing-set.csv"
MODEL_DEFAULT = ROOT / "data" / "models" / "unsw-nb15" / "unsw_nb15_random_forest.joblib"
RESULT_DEFAULT = ROOT / "research" / "unsw-nb15" / "classifier-evaluation.json"
PREDICTIONS_DEFAULT = ROOT / "research" / "unsw-nb15" / "classifier-predictions.csv"

TARGET_COLUMNS = {"id", "label", "attack_cat"}
CATEGORICAL_COLUMNS = ["proto", "service", "state"]


def load_dataset(path: Path) -> tuple[pd.DataFrame, np.ndarray, pd.Series, pd.Series]:
    frame = pd.read_csv(path, low_memory=False)
    required = TARGET_COLUMNS | set(CATEGORICAL_COLUMNS)
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"Faltan columnas requeridas en {path}: {', '.join(sorted(missing))}")
    labels = pd.to_numeric(frame["label"], errors="raise").astype(int).to_numpy()
    categories = frame["attack_cat"].fillna("Unknown").astype(str)
    ids = frame["id"].astype(str)
    features = frame.drop(columns=sorted(TARGET_COLUMNS)).copy()
    for column in CATEGORICAL_COLUMNS:
        features[column] = features[column].fillna("Unknown").astype(str)
    numeric_columns = [column for column in features.columns if column not in CATEGORICAL_COLUMNS]
    for column in numeric_columns:
        features[column] = pd.to_numeric(features[column], errors="coerce")
    return features, labels, categories, ids


def build_pipeline(numeric_columns: list[str]) -> Pipeline:
    preprocessing = ColumnTransformer(
        transformers=[
            ("numeric", SimpleImputer(strategy="median"), numeric_columns),
            (
                "categorical",
                OneHotEncoder(handle_unknown="ignore"),
                CATEGORICAL_COLUMNS,
            ),
        ],
        remainder="drop",
    )
    classifier = RandomForestClassifier(
        n_estimators=120,
        max_depth=24,
        min_samples_leaf=2,
        max_features="sqrt",
        class_weight="balanced_subsample",
        n_jobs=-1,
        random_state=2026,
        oob_score=True,
    )
    return Pipeline([("preprocess", preprocessing), ("classifier", classifier)])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", type=Path, default=TRAIN_DEFAULT)
    parser.add_argument("--test", type=Path, default=TEST_DEFAULT)
    parser.add_argument("--model-output", type=Path, default=MODEL_DEFAULT)
    parser.add_argument("--results-output", type=Path, default=RESULT_DEFAULT)
    parser.add_argument("--predictions-output", type=Path, default=PREDICTIONS_DEFAULT)
    parser.add_argument("--trees", type=int, default=120)
    parser.add_argument(
        "--target-recall",
        type=float,
        default=0.99,
        help="Recall objetivo para seleccionar el umbral usando predicciones out-of-bag del entrenamiento.",
    )
    args = parser.parse_args()
    if args.trees < 1:
        parser.error("--trees debe ser mayor que cero")
    if not 0 < args.target_recall <= 1:
        parser.error("--target-recall debe estar en el intervalo (0, 1]")
    if not args.train.is_file() or not args.test.is_file():
        parser.error("No encuentro los CSV de entrenamiento/prueba en las rutas indicadas.")

    train_x, train_y, train_categories, _ = load_dataset(args.train)
    test_x, test_y, test_categories, test_ids = load_dataset(args.test)
    if list(train_x.columns) != list(test_x.columns):
        raise ValueError("Las columnas de entrenamiento y prueba no coinciden en orden.")

    numeric_columns = [column for column in train_x.columns if column not in CATEGORICAL_COLUMNS]
    pipeline = build_pipeline(numeric_columns)
    pipeline.named_steps["classifier"].set_params(n_estimators=args.trees)

    training_started = time.perf_counter()
    pipeline.fit(train_x, train_y)
    training_seconds = time.perf_counter() - training_started

    classifier = pipeline.named_steps["classifier"]
    class_index = list(classifier.classes_).index(1)
    oob_probabilities = classifier.oob_decision_function_[:, class_index]
    oob_valid = np.isfinite(oob_probabilities)
    oob_precision, oob_recall, oob_thresholds = precision_recall_curve(
        train_y[oob_valid], oob_probabilities[oob_valid]
    )
    eligible_thresholds = np.flatnonzero(oob_recall[:-1] >= args.target_recall)
    decision_threshold = (
        float(oob_thresholds[eligible_thresholds[-1]]) if len(eligible_thresholds) else 0.5
    )
    oob_predicted = (oob_probabilities[oob_valid] >= decision_threshold).astype(int)
    oob_metrics = {
        "target_recall": args.target_recall,
        "selected_threshold": decision_threshold,
        "observed_oob_recall": float(recall_score(train_y[oob_valid], oob_predicted, zero_division=0)),
        "observed_oob_precision": float(precision_score(train_y[oob_valid], oob_predicted, zero_division=0)),
        "oob_records": int(oob_valid.sum()),
    }

    inference_started = time.perf_counter()
    probabilities = pipeline.predict_proba(test_x)[:, class_index]
    predictions = (probabilities >= decision_threshold).astype(int)
    inference_seconds = time.perf_counter() - inference_started

    tn, fp, fn, tp = (int(value) for value in confusion_matrix(test_y, predictions, labels=[0, 1]).ravel())
    category_metrics: dict[str, dict[str, float | int]] = {}
    for category in sorted(test_categories.unique()):
        mask = test_categories.to_numpy() == category
        count = int(mask.sum())
        if count == 0:
            continue
        category_metrics[category] = {
            "count": count,
            "attack_recall": round(float((predictions[mask] == 1).mean()), 6),
            "mean_attack_probability": round(float(probabilities[mask].mean()), 6),
        }

    metrics = {
        "experiment": "UNSW-NB15 binary intrusion classification",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": "UNSW-NB15",
        "train_file": args.train.name,
        "test_file": args.test.name,
        "train_rows": int(len(train_y)),
        "test_rows": int(len(test_y)),
        "feature_count": int(train_x.shape[1]),
        "excluded_columns": sorted(TARGET_COLUMNS),
        "categorical_features": CATEGORICAL_COLUMNS,
        "model": "RandomForestClassifier",
        "parameters": {
            "n_estimators": args.trees,
            "max_depth": 24,
            "min_samples_leaf": 2,
            "max_features": "sqrt",
            "class_weight": "balanced_subsample",
            "random_state": 2026,
            "decision_threshold": decision_threshold,
            "threshold_selection": "highest out-of-bag threshold meeting target recall on the training split",
        },
        "versions": {
            "python": platform.python_version(),
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "scikit_learn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "train_class_counts": {"normal": int((train_y == 0).sum()), "attack": int((train_y == 1).sum())},
        "test_class_counts": {"normal": int((test_y == 0).sum()), "attack": int((test_y == 1).sum())},
        "confusion_matrix": {"true_negative": tn, "false_positive": fp, "false_negative": fn, "true_positive": tp},
        "metrics": {
            "accuracy": round(float(accuracy_score(test_y, predictions)), 6),
            "balanced_accuracy": round(float(balanced_accuracy_score(test_y, predictions)), 6),
            "precision": round(float(precision_score(test_y, predictions, zero_division=0)), 6),
            "recall": round(float(recall_score(test_y, predictions, zero_division=0)), 6),
            "specificity": round(float(tn / (tn + fp)) if tn + fp else 0.0, 6),
            "f1": round(float(f1_score(test_y, predictions, zero_division=0)), 6),
            "roc_auc": round(float(roc_auc_score(test_y, probabilities)), 6),
            "mean_inference_ms_per_record": round(inference_seconds * 1000 / len(test_y), 6),
        },
        "training_oob_threshold_selection": oob_metrics,
        "timing_seconds": {
            "training": round(training_seconds, 3),
            "full_test_inference": round(inference_seconds, 3),
        },
        "per_attack_category": category_metrics,
        "notes": [
            "Model fitted only on the official training CSV; final metrics use the official testing CSV.",
            "The columns id, label and attack_cat were excluded from model inputs.",
            "The decision threshold was selected from training out-of-bag predictions to meet the configured recall target, then applied unchanged to the official testing set.",
            "UNSW-NB15 source/destination IP addresses are not available in these feature CSVs.",
        ],
    }

    args.model_output.parent.mkdir(parents=True, exist_ok=True)
    args.results_output.parent.mkdir(parents=True, exist_ok=True)
    args.predictions_output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "pipeline": pipeline,
            "feature_columns": list(train_x.columns),
            "excluded_columns": sorted(TARGET_COLUMNS),
            "model_name": "UNSW-NB15 Random Forest binary v2 OOB-calibrated",
            "decision_threshold": decision_threshold,
        },
        args.model_output,
        compress=3,
    )
    args.results_output.write_text(json.dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    pd.DataFrame(
        {
            "id": test_ids,
            "actual_label": test_y,
            "attack_cat": test_categories,
            "predicted_label": predictions,
            "attack_probability": probabilities,
        }
    ).to_csv(args.predictions_output, index=False)

    print(json.dumps(metrics, indent=2, ensure_ascii=False))
    print(f"Modelo: {args.model_output}")
    print(f"Resultados: {args.results_output}")
    print(f"Predicciones: {args.predictions_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
