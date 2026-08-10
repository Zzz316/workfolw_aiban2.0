"""Pipeline YAML metadata parser for AiBan Runner.

This module is the Python-side authority for turning ``main-flow.yaml`` into
stable runtime metadata.  Node-RED should consume the Runner's metadata output
instead of maintaining a second parser for Pipeline groups.
"""

import os
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


SCHEMA_VERSION = "pipeline-config/v1"

_MISSING = object()


class PipelineConfigError(Exception):
    """Configuration parse/validation error with a stable machine code."""

    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "details": dict(self.details),
        }


def parse_pipeline_config(path: str, base_dir: Optional[str] = None) -> Dict[str, Any]:
    """Parse and normalize AiBan Pipeline group/source/model metadata.

    Args:
        path: Path to the generated ``main-flow.yaml``.
        base_dir: Base directory for relative ``path`` values.  Defaults to
            the current working directory.

    Returns:
        A dict safe to embed in ``runtime_ready.payload``.

    Raises:
        PipelineConfigError: If the config cannot be parsed or validated.
    """

    if not path or not str(path).strip():
        raise PipelineConfigError(
            "PIPELINE_CONFIG_REQUIRED",
            "pipeline_config is required when not using mock metadata",
        )

    config_path = str(path)
    normalized_path = _normalize_path(config_path, base_dir or os.getcwd())
    if not os.path.exists(normalized_path):
        raise PipelineConfigError(
            "PIPELINE_CONFIG_NOT_FOUND",
            "main pipeline config file does not exist",
            {"path": config_path, "path_normalized": normalized_path},
        )

    root = _load_yaml_document(
        normalized_path,
        not_found_code="PIPELINE_CONFIG_NOT_FOUND",
        invalid_code="PIPELINE_CONFIG_INVALID_ROOT",
    )
    if not isinstance(root, Mapping):
        raise PipelineConfigError(
            "PIPELINE_CONFIG_INVALID_ROOT",
            "main pipeline config must be a YAML mapping",
            {"path": config_path, "path_normalized": normalized_path},
        )

    config_dir = os.path.dirname(normalized_path)
    models = _parse_models(root, config_dir)
    model_ids = {model["model_id"] for model in models}
    groups, sources_per_group, disabled_groups = _parse_groups(root, config_dir, model_ids)

    return {
        "schema_version": SCHEMA_VERSION,
        "config_path": config_path,
        "config_path_normalized": normalized_path,
        "groups": groups,
        "sources_per_group": sources_per_group,
        "models": models,
        "models_loaded": [model["model_id_str"] for model in models],
        "disabled_groups": disabled_groups,
    }


def build_mock_pipeline_metadata(
    num_groups: Any = 1,
    num_sources: Any = 1,
    model_ids: Optional[Sequence[Any]] = None,
) -> Dict[str, Any]:
    """Build contract-compatible metadata for mock Runner mode."""

    group_count = max(1, _coerce_count(num_groups, 1))
    source_count = max(1, _coerce_count(num_sources, 1))
    normalized_model_ids = _normalize_mock_model_ids(model_ids or [1])

    models = [
        {
            "model_id": model_id,
            "model_id_str": str(model_id),
            "name": f"mock-model-{model_id}",
            "enabled": True,
            "model_path": "",
            "model_path_normalized": "",
        }
        for model_id in normalized_model_ids
    ]

    groups: List[Dict[str, Any]] = []
    sources_per_group: Dict[str, List[int]] = {}
    for group_id in range(1, group_count + 1):
        sources = [
            {
                "source_id": source_id,
                "source_id_str": str(source_id),
                "name": f"mock-source-{source_id}",
                "enabled": True,
                "config_path": "",
                "config_path_normalized": "",
            }
            for source_id in range(1, source_count + 1)
        ]
        infers = [
            {
                "model_id": model_id,
                "model_id_str": str(model_id),
                "enabled": True,
            }
            for model_id in normalized_model_ids
        ]
        groups.append({
            "group_id": group_id,
            "group_id_str": str(group_id),
            "name": f"mock-group-{group_id}",
            "enabled": True,
            "sources": sources,
            "infers": infers,
            "model_ids": normalized_model_ids,
            "model_id_strs": [str(model_id) for model_id in normalized_model_ids],
        })
        sources_per_group[str(group_id)] = [source["source_id"] for source in sources]

    return {
        "schema_version": SCHEMA_VERSION,
        "config_path": "",
        "config_path_normalized": "",
        "groups": groups,
        "sources_per_group": sources_per_group,
        "models": models,
        "models_loaded": [model["model_id_str"] for model in models],
        "disabled_groups": [],
    }


def _parse_models(root: Mapping[str, Any], config_dir: str) -> List[Dict[str, Any]]:
    section = _first(root, ("ModelArrary", "ModelArray", "model_arrary", "model_array"))
    if section is _MISSING:
        section = _first(root, ("Models", "models"), [])

    if isinstance(section, Mapping):
        entries = _first(section, ("Models", "models", "items"), [])
    else:
        entries = section

    model_entries = _as_list(
        entries,
        code="PIPELINE_CONFIG_INVALID_MODELS",
        message="ModelArrary/Models must be a list",
    )

    models: List[Dict[str, Any]] = []
    seen_model_ids = set()
    for index, entry in enumerate(model_entries):
        if not isinstance(entry, Mapping):
            raise PipelineConfigError(
                "PIPELINE_CONFIG_INVALID_MODEL",
                "model entry must be a mapping",
                {"model_index": index},
            )

        raw_model_id = _first(entry, ("modelid", "model_id", "modeid", "id"))
        model_id = _normalize_int_id(
            raw_model_id,
            field="model_id",
            code="PIPELINE_CONFIG_INVALID_MODEL_ID",
            details={"model_index": index},
        )
        if model_id in seen_model_ids:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_DUPLICATE_MODEL_ID",
                "duplicate model_id in ModelArrary",
                {"model_id": model_id, "model_index": index},
            )
        seen_model_ids.add(model_id)

        model_path = _string_or_empty(_first(
            entry,
            ("modelpath", "model_path", "path", "weights", "config"),
            "",
        ))
        models.append({
            "model_id": model_id,
            "model_id_str": str(model_id),
            "name": _string_or_empty(_first(entry, ("name", "modelname", "model_name"), "")),
            "enabled": _parse_bool(_first(entry, ("enable", "enabled", "modelenable"), True), True),
            "model_path": model_path,
            "model_path_normalized": _normalize_path(model_path, config_dir) if model_path else "",
        })

    return models


def _parse_groups(
    root: Mapping[str, Any],
    config_dir: str,
    model_ids: Iterable[int],
) -> Tuple[List[Dict[str, Any]], Dict[str, List[int]], List[int]]:
    group_entries = _as_list(
        _first(root, ("GroupArrary", "GroupArray", "Groups", "groups")),
        code="PIPELINE_CONFIG_INVALID_GROUPS",
        message="GroupArrary/Groups must be a list",
    )
    if not group_entries:
        raise PipelineConfigError(
            "PIPELINE_CONFIG_NO_GROUPS",
            "main pipeline config must define at least one group",
        )

    known_model_ids = set(model_ids)
    groups: List[Dict[str, Any]] = []
    sources_per_group: Dict[str, List[int]] = {}
    disabled_groups: List[int] = []
    seen_group_ids = set()

    for group_index, group_entry in enumerate(group_entries):
        if not isinstance(group_entry, Mapping):
            raise PipelineConfigError(
                "PIPELINE_CONFIG_INVALID_GROUP",
                "group entry must be a mapping",
                {"group_index": group_index},
            )

        group_id = _normalize_int_id(
            _first(group_entry, ("groupid", "group_id", "id")),
            field="group_id",
            code="PIPELINE_CONFIG_INVALID_GROUP_ID",
            details={"group_index": group_index},
        )
        if group_id in seen_group_ids:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_DUPLICATE_GROUP_ID",
                "duplicate group_id in GroupArrary",
                {"group_id": group_id, "group_index": group_index},
            )
        seen_group_ids.add(group_id)

        enabled = _parse_bool(
            _first(group_entry, ("groupenable", "group_enable", "enabled", "enable"), True),
            True,
        )
        sources = _parse_sources_for_group(group_entry, config_dir, group_id)
        infers, group_model_ids = _parse_infers_for_group(
            group_entry,
            group_id=group_id,
            known_model_ids=known_model_ids,
        )

        group = {
            "group_id": group_id,
            "group_id_str": str(group_id),
            "name": _string_or_empty(_first(
                group_entry,
                ("groupname", "group_name", "name"),
                f"group-{group_id}",
            )),
            "enabled": enabled,
            "sources": sources,
            "infers": infers,
            "model_ids": group_model_ids,
            "model_id_strs": [str(model_id) for model_id in group_model_ids],
        }
        groups.append(group)
        sources_per_group[str(group_id)] = [source["source_id"] for source in sources]
        if not enabled:
            disabled_groups.append(group_id)

    return groups, sources_per_group, disabled_groups


def _parse_sources_for_group(
    group_entry: Mapping[str, Any],
    config_dir: str,
    group_id: int,
) -> List[Dict[str, Any]]:
    source_entries = _as_list(
        _first(group_entry, ("Sources", "sources", "SourceArray", "source_array"), []),
        code="PIPELINE_CONFIG_INVALID_SOURCES",
        message="Sources must be a list",
        details={"group_id": group_id},
    )

    sources: List[Dict[str, Any]] = []
    seen_source_ids = set()
    for source_index, source_entry in enumerate(source_entries):
        if isinstance(source_entry, str):
            source_ref: Mapping[str, Any] = {"config": source_entry}
        elif isinstance(source_entry, Mapping):
            source_ref = source_entry
        else:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_INVALID_SOURCE_REF",
                "source reference must be a mapping or path string",
                {"group_id": group_id, "source_index": source_index},
            )

        config_path = _string_or_empty(_first(
            source_ref,
            ("config", "path", "source_config", "sourceConfig", "yaml"),
            "",
        ))
        if not config_path:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_MISSING_SOURCE_CONFIG",
                "source reference is missing a config path",
                {"group_id": group_id, "source_index": source_index},
            )

        normalized_path = _normalize_path(config_path, config_dir)
        if not os.path.exists(normalized_path):
            raise PipelineConfigError(
                "PIPELINE_CONFIG_SOURCE_NOT_FOUND",
                "source config file does not exist",
                {
                    "group_id": group_id,
                    "source_index": source_index,
                    "config_path": config_path,
                    "config_path_normalized": normalized_path,
                },
            )

        source_doc = _load_yaml_document(
            normalized_path,
            not_found_code="PIPELINE_CONFIG_SOURCE_NOT_FOUND",
            invalid_code="PIPELINE_CONFIG_INVALID_SOURCE",
        )
        if not isinstance(source_doc, Mapping):
            raise PipelineConfigError(
                "PIPELINE_CONFIG_INVALID_SOURCE",
                "source config must be a YAML mapping",
                {
                    "group_id": group_id,
                    "source_index": source_index,
                    "config_path": config_path,
                    "config_path_normalized": normalized_path,
                },
            )

        source_id = _normalize_int_id(
            _first(
                source_doc,
                ("id", "source_id", "sourceid", "camera_id", "cameraid"),
                _first(source_ref, ("id", "source_id", "sourceid", "camera_id", "cameraid")),
            ),
            field="source_id",
            code="PIPELINE_CONFIG_INVALID_SOURCE_ID",
            details={"group_id": group_id, "source_index": source_index},
        )
        if source_id in seen_source_ids:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_DUPLICATE_SOURCE_ID",
                "duplicate source_id within group",
                {"group_id": group_id, "source_id": source_id, "source_index": source_index},
            )
        seen_source_ids.add(source_id)

        entry_enabled = _parse_bool(
            _first(source_ref, ("enable", "enabled", "sourceenable", "source_enable"), True),
            True,
        )
        stream_enabled = _parse_bool(_first(source_doc, ("enablestream", "stream_enabled"), True), True)
        infer_enabled = _parse_bool(_first(source_doc, ("inferenable", "infer_enabled"), True), True)
        temp_run = _parse_bool(_first(source_doc, ("temprun", "temp_run"), True), True)

        source = {
            "source_id": source_id,
            "source_id_str": str(source_id),
            "name": _string_or_empty(_first(source_doc, ("name", "sourcename", "source_name"), "")),
            "enabled": entry_enabled and stream_enabled and infer_enabled and temp_run,
            "config_path": config_path,
            "config_path_normalized": normalized_path,
        }
        fps = _first(source_doc, ("fps", "stream_fps"))
        if fps is not _MISSING:
            source["fps"] = _coerce_count(fps, 0)
        decode_cache = _first(source_doc, ("decodecache", "stream_cache"))
        if decode_cache is not _MISSING:
            source["decodecache"] = _coerce_count(decode_cache, 0)
        sources.append(source)

    return sources


def _parse_infers_for_group(
    group_entry: Mapping[str, Any],
    group_id: int,
    known_model_ids: set,
) -> Tuple[List[Dict[str, Any]], List[int]]:
    infer_entries = _as_list(
        _first(group_entry, ("Infers", "infers", "InferArray", "infer_array"), []),
        code="PIPELINE_CONFIG_INVALID_INFERS",
        message="Infers must be a list",
        details={"group_id": group_id},
    )

    infers: List[Dict[str, Any]] = []
    group_model_ids: List[int] = []
    seen_group_models = set()
    for infer_index, infer_entry in enumerate(infer_entries):
        if not isinstance(infer_entry, Mapping):
            raise PipelineConfigError(
                "PIPELINE_CONFIG_INVALID_INFER",
                "infer entry must be a mapping",
                {"group_id": group_id, "infer_index": infer_index},
            )

        model_id = _normalize_int_id(
            _first(infer_entry, ("modeid", "modelid", "model_id", "id")),
            field="model_id",
            code="PIPELINE_CONFIG_INVALID_MODEL_REF",
            details={"group_id": group_id, "infer_index": infer_index},
        )
        if model_id not in known_model_ids:
            raise PipelineConfigError(
                "PIPELINE_CONFIG_UNKNOWN_MODEL_REF",
                "group infer references an unknown model_id",
                {"group_id": group_id, "model_id": model_id, "infer_index": infer_index},
            )

        enabled = _parse_bool(_first(infer_entry, ("enable", "enabled", "inferenable"), True), True)
        infers.append({
            "model_id": model_id,
            "model_id_str": str(model_id),
            "enabled": enabled,
        })
        if model_id not in seen_group_models:
            group_model_ids.append(model_id)
            seen_group_models.add(model_id)

    return infers, group_model_ids


def _load_yaml_document(path: str, not_found_code: str, invalid_code: str) -> Any:
    try:
        import yaml  # type: ignore
    except Exception as exc:
        raise PipelineConfigError(
            "PIPELINE_CONFIG_YAML_IMPORT_FAILED",
            "PyYAML is required to parse pipeline config files",
            {"error": str(exc)},
        ) from exc

    if not os.path.exists(path):
        raise PipelineConfigError(
            not_found_code,
            "YAML config file does not exist",
            {"path_normalized": path},
        )

    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            return yaml.safe_load(handle) or {}
    except PipelineConfigError:
        raise
    except Exception as exc:
        raise PipelineConfigError(
            invalid_code,
            "failed to parse YAML config file",
            {"path_normalized": path, "error": str(exc)},
        ) from exc


def _first(mapping: Mapping[str, Any], keys: Sequence[str], default: Any = _MISSING) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return default


def _as_list(
    value: Any,
    code: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
) -> List[Any]:
    if value is _MISSING or value is None:
        return []
    if isinstance(value, list):
        return value
    raise PipelineConfigError(code, message, details)


def _normalize_int_id(value: Any, field: str, code: str, details: Optional[Dict[str, Any]] = None) -> int:
    if value is _MISSING or value is None:
        merged = dict(details or {})
        merged["field"] = field
        raise PipelineConfigError(code, f"{field} is required", merged)

    try:
        if isinstance(value, bool):
            raise ValueError("boolean is not a valid id")
        if isinstance(value, int):
            result = value
        elif isinstance(value, float):
            if not value.is_integer():
                raise ValueError("id float must be an integer value")
            result = int(value)
        else:
            text = str(value).strip()
            if not text:
                raise ValueError("id is empty")
            if "." in text:
                number = float(text)
                if not number.is_integer():
                    raise ValueError("id float string must be an integer value")
                result = int(number)
            else:
                result = int(text, 10)
    except Exception as exc:
        merged = dict(details or {})
        merged.update({"field": field, "value": value})
        raise PipelineConfigError(code, f"{field} must be an integer-like value", merged) from exc

    if result < 0:
        merged = dict(details or {})
        merged.update({"field": field, "value": value})
        raise PipelineConfigError(code, f"{field} must not be negative", merged)
    return result


def _parse_bool(value: Any, default: bool) -> bool:
    if value is _MISSING or value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "y", "on"):
        return True
    if text in ("0", "false", "no", "n", "off"):
        return False
    return default


def _string_or_empty(value: Any) -> str:
    if value is _MISSING or value is None:
        return ""
    return str(value)


def _normalize_path(path: str, base_dir: str) -> str:
    text = str(path).strip()
    if not text:
        return ""
    expanded = os.path.expandvars(os.path.expanduser(text))
    if _is_absolute_path(expanded):
        return os.path.normpath(expanded)
    return os.path.normpath(os.path.abspath(os.path.join(base_dir, expanded)))


def _is_absolute_path(path: str) -> bool:
    if os.path.isabs(path):
        return True
    if len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/"):
        return True
    return path.startswith("\\\\") or path.startswith("//")


def _coerce_count(value: Any, default: int) -> int:
    try:
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        text = str(value).strip()
        if not text:
            return default
        return int(float(text))
    except Exception:
        return default


def _normalize_mock_model_ids(model_ids: Sequence[Any]) -> List[int]:
    normalized: List[int] = []
    seen = set()
    for index, model_id in enumerate(model_ids):
        parsed = _normalize_int_id(
            model_id,
            field="model_id",
            code="PIPELINE_CONFIG_INVALID_MODEL_ID",
            details={"model_index": index, "source": "mock_config"},
        )
        if parsed not in seen:
            normalized.append(parsed)
            seen.add(parsed)
    return normalized or [1]
