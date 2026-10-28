"""一个够用的 JSON Schema 子集校验器（type / required / properties / enum / items / additionalProperties）。

为什么不直接信任模型给的参数？开了 eager_input_streaming 后服务端不再校验，
SDK 的宽容解析器还可能给出被截断的对象。执行前自己查一遍，错了就把错误当工具结果还给模型。
"""

from __future__ import annotations

from typing import Any

_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,), "integer": (int,), "number": (int, float), "boolean": (bool,),
    "array": (list,), "object": (dict,),
}


def validate(value: Any, schema: dict[str, Any], path: str = "input") -> list[str]:
    errors: list[str] = []
    t = schema.get("type")
    if t:
        ok = isinstance(value, _TYPES[t]) and not (t in ("integer", "number") and isinstance(value, bool))
        if not ok:
            return [f"{path} should be {t}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path} must be one of {schema['enum']}, got {value!r}")
    if t == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"The required parameter `{key}` is missing")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"An unexpected parameter `{key}` was provided")
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(value[key], sub, f"{path}.{key}"))
    if t == "array" and "items" in schema:
        for i, item in enumerate(value):
            errors.extend(validate(item, schema["items"], f"{path}[{i}]"))
    for bound, cmp, msg in (("minItems", lambda a, b: a >= b, "at least"), ("maxItems", lambda a, b: a <= b, "at most")):
        if t == "array" and bound in schema and not cmp(len(value), schema[bound]):
            errors.append(f"{path} must have {msg} {schema[bound]} items")
    return errors
